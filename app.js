'use strict';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const REFRESH_MS = 5 * 60 * 1000;
const RENEW_BEFORE_MS = 15 * 60 * 1000;
const RENEW_TIMEOUT_MS = 60 * 1000;
const STALE_ALERT_MS = 90 * 1000;
const JOIN_WINDOW_MS = 2 * 60 * 1000;
const FOCUS_MIN = 25;
const FOCUS_MIN_GAP = 10;
const SHIFT_MS = 3 * 60 * 1000;
// Spanish variants follow the device (es-ES, es-AR…); other languages keep es-MX since the UI is Spanish.
const LOCALE = navigator.language?.toLowerCase().startsWith('es') ? navigator.language : 'es-MX';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};

const settings = Object.assign(
  {
    clientId: '', wake: true, seconds: true, h24: false, alertMin: 5, sound: true,
    calendars: ['primary'], night: true, nightFrom: '22:00', nightTo: '07:00',
  },
  store.get('settings', {}),
);

let tokenClient = null;
let events = [];
let tomorrowFirst = null;
let focus = store.get('focus', null);
let lastShift = 0;
let lastFetch = 0;
let lastActiveKey = '';
let renewingSince = 0;
let authGen = 0; // bumped on disconnect so in-flight token responses are dropped
const alerted = new Set();
let lastAlertCheck = Date.now();

// ---------- Clock ----------

function timeFormatter() {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: settings.h24 ? 'h23' : 'h12',
  });
}

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

let currentDay = todayKey();

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function tick() {
  const now = new Date();
  const parts = timeFormatter().formatToParts(now);
  const hm = parts
    .filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal')
    .map((p) => p.value).join('').trim();
  const period = parts.find((p) => p.type === 'dayPeriod');

  $('hm').textContent = hm;
  $('sec').textContent = settings.seconds ? ':' + String(now.getSeconds()).padStart(2, '0') : '';
  $('ampm').textContent = period ? period.value : '';
  const date = dateFormatter.format(now);
  $('date').textContent = date.charAt(0).toUpperCase() + date.slice(1);

  if (todayKey(now) !== currentDay) {
    currentDay = todayKey(now);
    events = [];
    tomorrowFirst = null;
    loadEvents();
  }
  if (now.getSeconds() === 0) renderEvents();
  if (Date.now() - lastFetch > REFRESH_MS) loadEvents();
  checkAlerts();
  renderFocus();
  applyNight(now);
  shiftClock();

  setTimeout(tick, 1000 - (Date.now() % 1000));
}

// ---------- Google Calendar ----------

function getToken() {
  const t = store.get('token', null);
  return t && t.exp > Date.now() + 60_000 ? t.value : null;
}

function initGoogle() {
  if (!settings.clientId || !window.google?.accounts?.oauth2) return false;
  const gen = authGen;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    callback: (resp) => {
      if (gen !== authGen) return;
      renewingSince = 0;
      if (resp.error) {
        setStatus('No se pudo conectar con Google', true);
        return;
      }
      store.set('token', { value: resp.access_token, exp: Date.now() + resp.expires_in * 1000 });
      lastFetch = 0;
      loadEvents();
    },
    // Popup blocked or closed: leave the tap-to-refresh status as the fallback.
    error_callback: () => {
      renewingSince = 0;
      if (!getToken()) setStatus('Toca aquí para actualizar el calendario', true);
    },
  });
  return true;
}

function isRenewing() {
  return Date.now() - renewingSince < RENEW_TIMEOUT_MS;
}

// Implicit-flow tokens last ~1 h with no refresh token, and GIS needs a user gesture
// to open its popup, so renewal piggybacks on any tap in the last stretch before expiry.
// With consent already granted the popup closes on its own.
function maybeRenewToken() {
  const t = store.get('token', null);
  if (!t || isRenewing() || !settings.clientId) return;
  if (t.exp - Date.now() > RENEW_BEFORE_MS) return;
  if (!tokenClient && !initGoogle()) return;
  renewingSince = Date.now();
  tokenClient.requestAccessToken({ prompt: '' });
}

function requestToken(interactive) {
  if (!tokenClient && !initGoogle()) {
    openSettings();
    return;
  }
  renewingSince = Date.now();
  tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
}

async function loadEvents() {
  lastFetch = Date.now();
  const cached = store.get('events', null);
  if (cached && cached.day === currentDay) {
    events = cached.items;
    tomorrowFirst = cached.tomorrow || null;
    renderEvents();
  }

  if (!settings.clientId) {
    $('connect').hidden = false;
    $('connect').textContent = 'Configurar Google Calendar';
    return;
  }

  const token = getToken();
  if (!token) {
    const hadToken = store.get('token', null) !== null;
    $('connect').hidden = hadToken;
    $('connect').textContent = 'Conectar Google Calendar';
    if (hadToken) setStatus('Toca aquí para actualizar el calendario', true);
    return;
  }

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const endOfToday = new Date(start); endOfToday.setDate(endOfToday.getDate() + 1);
  // Fetch through tomorrow so the empty state can show the first meeting of the next day.
  const end = new Date(start); end.setDate(end.getDate() + 2);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });

  try {
    const me = await myEmail(token);
    // One broken calendar (revoked share, rate limit) must not block the others.
    const results = await Promise.allSettled(
      settings.calendars.map((id) => fetchCalendar(id, params, token, me)),
    );
    if (results.some((r) => r.status === 'fulfilled' && r.value === null)) {
      store.set('token', { value: '', exp: 0 });
      setStatus('Toca aquí para actualizar el calendario', true);
      return;
    }
    const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!lists.length) throw new Error('all calendars failed');
    // The same meeting can appear in several selected calendars, each in its own time zone.
    const seen = new Set();
    const all = lists.flat()
      .filter((ev) => {
        const key = `${ev.uid}|${startDate(ev).getTime()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (b.allDay - a.allDay) || (startDate(a) - startDate(b)));
    events = all.filter((ev) => startDate(ev) < endOfToday);
    tomorrowFirst = all.find((ev) => !ev.allDay && startDate(ev) >= endOfToday) || null;
    store.set('events', { day: currentDay, items: events, tomorrow: tomorrowFirst });
    $('connect').hidden = true;
    setStatus(lists.length < results.length ? 'Algún calendario no se pudo cargar' : '');
    renderEvents();
  } catch {
    setStatus('Sin conexión — mostrando lo último guardado', false);
  }
}

// The signed-in user's address is the primary calendar's id. Needed because an attendee's
// `self` flag marks the calendar a copy lives on, not the user, when reading shared calendars.
async function myEmail(token) {
  const cached = store.get('me', null);
  if (cached) return cached;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return '';
    const { id } = await res.json();
    store.set('me', id);
    return id;
  } catch {
    return '';
  }
}

function isMe(attendee, me) {
  return me ? attendee.email?.toLowerCase() === me.toLowerCase() : !!attendee.self;
}

// Returns null on 401 so the caller can drop the token; a calendar that no longer exists yields [].
async function fetchCalendar(id, params, token, me) {
  const items = [];
  let pageToken = '';
  do {
    const page = new URLSearchParams(params);
    if (pageToken) page.set('pageToken', pageToken);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401) return null;
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return items
    .filter((ev) => ev.status !== 'cancelled')
    .filter((ev) => !(ev.attendees || []).some((a) => isMe(a, me) && a.responseStatus === 'declined'))
    .map((ev) => ({
      id: ev.id,
      uid: ev.iCalUID || ev.id,
      title: ev.summary || '(Sin título)',
      allDay: !ev.start.dateTime,
      start: ev.start.dateTime || ev.start.date,
      end: ev.end.dateTime || ev.end.date,
      link: ev.hangoutLink
        || ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
        || '',
      location: ev.location || '',
      description: htmlToText(ev.description || '').slice(0, 2000),
      attendees: (ev.attendees || [])
        .filter((a) => !a.resource)
        .map((a) => ({ name: a.displayName || a.email, status: a.responseStatus, self: isMe(a, me) })),
    }));
}

// All-day dates ("2026-10-20") must be read as local midnight, not UTC.
function startDate(ev) {
  return new Date(ev.allDay ? `${ev.start}T00:00` : ev.start);
}

// Descriptions arrive as HTML or plain text; DOMParser never runs scripts, and only text is kept.
function htmlToText(html) {
  // Plain text like "budget <see notes>" must not be eaten as a tag.
  if (!/<\/?(a|b|i|u|p|br|div|span|ul|ol|li|strong|em|html)\b/i.test(html)) return html.trim();
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  // Keep link targets (meeting notes, docs) that the anchor text would otherwise hide.
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href) && a.textContent.trim() !== href) a.append(` (${href})`);
  });
  return doc.body.textContent.trim();
}

async function listCalendars() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()).items || [];
  } catch {
    return null;
  }
}

// ---------- Rendering ----------

function fmtTime(iso) {
  return timeFormatter().format(new Date(iso));
}

function minutesUntil(date) {
  return Math.round((date - Date.now()) / 60000);
}

function humanMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function renderEvents() {
  const list = $('events');
  list.replaceChildren();
  const now = Date.now();
  const timed = events.filter((e) => !e.allDay);
  const current = timed.filter((e) => new Date(e.start) <= now && new Date(e.end) > now);
  const upcoming = timed.find((e) => new Date(e.start) > now);

  for (const ev of events) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const li = document.createElement('li');
    li.className = 'event';
    if (!ev.allDay) {
      if (end <= now) li.classList.add('past');
      else if (start <= now) li.classList.add('now');
      else if (ev === upcoming) li.classList.add('next-up');
    }

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = ev.allDay ? 'Todo el día' : `${fmtTime(ev.start)}\n${fmtTime(ev.end)}`;
    when.style.whiteSpace = 'pre-line';

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = ev.title;
    if (li.classList.contains('now')) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'AHORA';
      title.append(badge);
    }
    body.append(title);

    if (ev.link || ev.location) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      if (ev.link) {
        const a = document.createElement('a');
        a.href = ev.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Unirse a la reunión';
        meta.append(a);
      } else {
        meta.textContent = ev.location;
      }
      body.append(meta);
    }

    li.append(when, body);
    li.addEventListener('click', (e) => {
      if (!e.target.closest('a')) openDetails(ev);
    });
    list.append(li);
  }

  // Keep the current/next meeting in view; only scroll when it changes so manual scrolling sticks.
  const active = list.querySelector('.event.now, .event.next-up');
  const activeKey = active ? active.textContent : '';
  // The list only scrolls on its own in landscape; in portrait this is a no-op.
  if (active && activeKey !== lastActiveKey) {
    list.scrollTop = Math.max(0, active.offsetTop - 12);
  }
  lastActiveKey = activeKey;

  const remaining = events.some((e) => e.allDay || new Date(e.end) > now);
  $('empty').hidden = remaining || !store.get('events', null);
  const tomorrow = $('tomorrow');
  tomorrow.hidden = remaining || !tomorrowFirst;
  if (tomorrowFirst) tomorrow.textContent = `Mañana: ${fmtTime(tomorrowFirst.start)} · ${tomorrowFirst.title}`;

  const next = $('next');
  next.classList.remove('soon', 'imminent');
  if (upcoming && !current.length) {
    const ms = new Date(upcoming.start) - now;
    if (ms <= 60000) next.classList.add('imminent');
    else if (ms <= (settings.alertMin || 5) * 60000) next.classList.add('soon');
  }
  if (current.length) {
    const ev = current[0];
    next.textContent = `En curso: ${ev.title} · termina en ${humanMinutes(Math.max(1, minutesUntil(new Date(ev.end))))}`;
    next.hidden = false;
  } else if (upcoming) {
    next.textContent = `Siguiente: ${upcoming.title} en ${humanMinutes(Math.max(1, minutesUntil(new Date(upcoming.start))))}`;
    next.hidden = false;
  } else {
    next.hidden = true;
  }
  renderJoin(current, upcoming);
  renderFocus();
}

// Big join button from 2 min before start until 10 min in.
function renderJoin(current, upcoming) {
  const now = Date.now();
  const ev = [upcoming, ...current].find((e) => e && e.link
    && new Date(e.start) - now <= JOIN_WINDOW_MS
    && now - new Date(e.start) <= 10 * 60 * 1000);
  const join = $('join');
  join.hidden = !ev;
  if (ev) {
    join.href = ev.link;
    join.textContent = `Unirse a ${ev.title}`;
  }
}

function setStatus(text, actionable) {
  const el = $('status');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('warn', !!actionable);
}

// ---------- Event details ----------

const RSVP = { accepted: 'Asistirá', declined: 'No asistirá', tentative: 'Quizás', needsAction: 'Sin responder' };

function openDetails(ev) {
  $('d-title').textContent = ev.title;
  $('d-when').textContent = ev.allDay ? 'Todo el día' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
  $('d-location').textContent = ev.location;
  $('d-location').hidden = !ev.location;
  $('d-link').hidden = !ev.link;
  $('d-link').href = ev.link || '#';
  $('d-desc').textContent = ev.description || '';
  $('d-desc').hidden = !ev.description;
  const list = $('d-attendees');
  list.replaceChildren(...(ev.attendees || []).map((a) => {
    const li = document.createElement('li');
    li.textContent = a.self ? `${a.name} (tú)` : a.name;
    const st = document.createElement('span');
    st.className = `rsvp ${a.status}`;
    st.textContent = RSVP[a.status] || '';
    li.append(st);
    return li;
  }));
  list.hidden = !list.children.length;
  $('details').showModal();
}

// ---------- Focus block ----------

// Free time until the next meeting, or null while one is running.
function freeMinutes() {
  const now = Date.now();
  const timed = events.filter((e) => !e.allDay);
  if (timed.some((e) => new Date(e.start) <= now && new Date(e.end) > now)) return null;
  const upcoming = timed.find((e) => new Date(e.start) > now);
  return upcoming ? Math.floor((new Date(upcoming.start) - now) / 60000) : Infinity;
}

// Leave 2 min of slack before the next meeting.
function focusLength(free) {
  return Math.min(FOCUS_MIN, free - 2);
}

function startFocus() {
  const free = freeMinutes();
  // The button may have been rendered before a new meeting arrived.
  if (free === null || free < FOCUS_MIN_GAP) {
    renderFocus();
    return;
  }
  const min = focusLength(free);
  focus = { start: Date.now(), end: Date.now() + min * 60000 };
  store.set('focus', focus);
  renderFocus();
}

function stopFocus() {
  focus = null;
  store.remove('focus');
  renderFocus();
}

function renderFocus() {
  const now = Date.now();
  if (focus && now >= focus.end) {
    const { end } = focus;
    focus = null;
    store.remove('focus');
    // Only celebrate a block that just finished, not one that expired while the app was closed.
    if (now - end < STALE_ALERT_MS) alertFor(`focus|${end}`);
  }
  const btn = $('focus-btn');
  const label = $('focus');
  if (focus) {
    const left = Math.ceil((focus.end - now) / 1000);
    label.textContent = `Enfoque · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    label.hidden = false;
    btn.textContent = 'Terminar';
    btn.hidden = false;
  } else {
    label.hidden = true;
    const free = freeMinutes();
    btn.hidden = free === null || free < FOCUS_MIN_GAP;
    if (!btn.hidden) btn.textContent = `Bloque de enfoque · ${focusLength(free)} min`;
  }
  renderProgress(now);
}

// Thin bar under the clock: the focus block if one runs, else the current meeting.
function renderProgress(now) {
  const current = events.find((e) => !e.allDay && new Date(e.start) <= now && new Date(e.end) > now);
  const span = focus ? [focus.start, focus.end]
    : current ? [new Date(current.start).getTime(), new Date(current.end).getTime()] : null;
  const bar = $('progress');
  bar.hidden = !span;
  if (span) bar.style.setProperty('--p', `${Math.min(100, ((now - span[0]) / (span[1] - span[0])) * 100)}%`);
}

// ---------- Night mode & burn-in ----------

function toMinutes(hhmm, fallback) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : toMinutes(fallback, '00:00');
}

function applyNight(now) {
  let on = false;
  if (settings.night) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const from = toMinutes(settings.nightFrom, '22:00');
    const to = toMinutes(settings.nightTo, '07:00');
    // Same start and end means "always dim".
    on = from === to || (from < to ? cur >= from && cur < to : cur >= from || cur < to);
  }
  document.documentElement.classList.toggle('night', on);
}

// Nudge the clock a few pixels now and then so an always-on OLED doesn't burn in the digits.
function shiftClock() {
  if (Date.now() - lastShift < SHIFT_MS) return;
  lastShift = Date.now();
  const r = () => `${Math.round(Math.random() * 12 - 6)}px`;
  $('clock').style.setProperty('--dx', r());
  $('clock').style.setProperty('--dy', r());
}

// ---------- Meeting alerts ----------

let audioCtx = null;

// Browsers only allow audio after a user gesture, so the context is unlocked on the first tap.
function unlockAudio() {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}

function chime() {
  if (!settings.sound || !audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [880, 660].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    const t = t0 + i * 0.35;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
}

function alertFor(key) {
  alerted.add(key);
  chime();
  navigator.vibrate?.([200, 100, 200]);
  const clock = $('clock');
  clock.classList.remove('alerting');
  void clock.offsetWidth; // restart the animation
  clock.classList.add('alerting');
  renderEvents();
}

// One alert `alertMin` minutes before each meeting and one when it starts. Fires when a
// threshold was crossed since the last check, so throttled background timers still
// catch it, but not if it's older than STALE_ALERT_MS (e.g. reopening the app late).
function checkAlerts() {
  const now = Date.now();
  const since = Math.max(lastAlertCheck, now - STALE_ALERT_MS);
  lastAlertCheck = now;
  if (!settings.alertMin) return;
  for (const ev of events) {
    if (ev.allDay) continue;
    const start = new Date(ev.start).getTime();
    const thresholds = [[start - settings.alertMin * 60000, 'lead'], [start, 'start']];
    for (const [at, kind] of thresholds) {
      const key = `${ev.id}|${ev.start}|${kind}`;
      if (at > since && at <= now && !alerted.has(key)) {
        alertFor(key);
        break;
      }
    }
  }
}

// ---------- Screen wake lock ----------

let wakeLock = null;

async function applyWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (settings.wake && document.visibilityState === 'visible' && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied, e.g. battery saver */ }
  } else if (!settings.wake && wakeLock) {
    await wakeLock.release();
  }
}

// ---------- Settings ----------

function openSettings() {
  $('client-id').value = settings.clientId;
  $('wake').checked = settings.wake;
  $('seconds').checked = settings.seconds;
  $('h24').checked = settings.h24;
  $('alert-min').value = String(settings.alertMin);
  if (!$('alert-min').value) $('alert-min').value = '5';
  $('sound').checked = settings.sound;
  $('night').checked = settings.night;
  $('night-from').value = settings.nightFrom;
  $('night-to').value = settings.nightTo;
  renderCalendarChoices();
  $('settings').showModal();
}

async function renderCalendarChoices() {
  const box = $('calendars');
  box.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'muted', textContent: getToken() ? 'Cargando…' : 'Conecta Google Calendar para elegir.',
  }));
  const cals = await listCalendars();
  if (!cals) {
    if (getToken()) box.firstChild.textContent = 'No se pudieron cargar los calendarios. Vuelve a abrir Ajustes para reintentar.';
    return;
  }
  box.replaceChildren(...cals.map((cal) => {
    // The primary calendar is stored as 'primary' so the default keeps working across accounts.
    const id = cal.primary ? 'primary' : cal.id;
    const label = document.createElement('label');
    label.className = 'row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = settings.calendars.includes(id);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = cal.backgroundColor || 'var(--muted)';
    label.append(input, dot, cal.summaryOverride || cal.summary || id);
    return label;
  }));
}

$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const newId = $('client-id').value.trim();
  if (newId !== settings.clientId) {
    tokenClient = null;
    store.remove('token');
    store.remove('me');
  }
  settings.clientId = newId;
  settings.wake = $('wake').checked;
  settings.seconds = $('seconds').checked;
  settings.h24 = $('h24').checked;
  settings.alertMin = Number($('alert-min').value);
  settings.sound = $('sound').checked;
  settings.night = $('night').checked;
  settings.nightFrom = $('night-from').value || '22:00';
  settings.nightTo = $('night-to').value || '07:00';
  const boxes = [...$('calendars').querySelectorAll('input[type="checkbox"]')];
  // Only touch the selection if the list loaded; keep at least one calendar.
  if (boxes.length) {
    const picked = boxes.filter((b) => b.checked).map((b) => b.value);
    settings.calendars = picked.length ? picked : ['primary'];
  }
  store.set('settings', settings);
  applyWakeLock();
  renderEvents();
  lastFetch = 0;
});

$('disconnect').addEventListener('click', () => {
  const t = store.get('token', null);
  if (t?.value && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.value);
  authGen++;
  tokenClient = null;
  renewingSince = 0;
  store.remove('token');
  store.remove('events');
  store.remove('me');
  events = [];
  tomorrowFirst = null;
  renderEvents();
  $('settings').close();
  lastFetch = 0;
});

$('settings-btn').addEventListener('click', openSettings);
$('focus-btn').addEventListener('click', () => (focus ? stopFocus() : startFocus()));
$('clock').querySelector('.time').addEventListener('dblclick', () => {
  if (!document.fullscreenEnabled) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
// `click` counts as user activation for touch too (`pointerdown` only does for mouse).
// Controls handle their own token flow, so taps on them don't also trigger a renewal.
document.addEventListener('click', (e) => {
  unlockAudio();
  if (!e.target.closest('button, a, dialog, #status')) maybeRenewToken();
}, { capture: true });
$('connect').addEventListener('click', () => requestToken(!store.get('token', null)));
$('status').addEventListener('click', () => {
  if ($('status').classList.contains('warn')) requestToken(false);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    applyWakeLock();
    lastFetch = 0;
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

// The GIS script loads async; wait for it before wiring the token client.
window.addEventListener('load', () => initGoogle());

tick();
applyWakeLock();
