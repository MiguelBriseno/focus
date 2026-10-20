'use strict';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const REFRESH_MS = 5 * 60 * 1000;
const LOCALE = 'es-MX';

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
  { clientId: '', wake: true, seconds: true, h24: false },
  store.get('settings', {}),
);

let tokenClient = null;
let events = [];
let lastFetch = 0;

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
    loadEvents();
  }
  if (now.getSeconds() === 0) renderEvents();
  if (Date.now() - lastFetch > REFRESH_MS) loadEvents();

  setTimeout(tick, 1000 - (Date.now() % 1000));
}

// ---------- Google Calendar ----------

function getToken() {
  const t = store.get('token', null);
  return t && t.exp > Date.now() + 60_000 ? t.value : null;
}

function initGoogle() {
  if (!settings.clientId || !window.google?.accounts?.oauth2) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        setStatus('No se pudo conectar con Google', true);
        return;
      }
      store.set('token', { value: resp.access_token, exp: Date.now() + resp.expires_in * 1000 });
      lastFetch = 0;
      loadEvents();
    },
  });
  return true;
}

function requestToken(interactive) {
  if (!tokenClient && !initGoogle()) {
    openSettings();
    return;
  }
  tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
}

async function loadEvents() {
  lastFetch = Date.now();
  const cached = store.get('events', null);
  if (cached && cached.day === currentDay) {
    events = cached.items;
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
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401) {
      store.set('token', { value: '', exp: 0 });
      setStatus('Toca aquí para actualizar el calendario', true);
      return;
    }
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    events = (data.items || [])
      .filter((ev) => ev.status !== 'cancelled')
      .filter((ev) => !(ev.attendees || []).some((a) => a.self && a.responseStatus === 'declined'))
      .map((ev) => ({
        id: ev.id,
        title: ev.summary || '(Sin título)',
        allDay: !ev.start.dateTime,
        start: ev.start.dateTime || ev.start.date,
        end: ev.end.dateTime || ev.end.date,
        link: ev.hangoutLink
          || ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
          || '',
        location: ev.location || '',
      }));
    store.set('events', { day: currentDay, items: events });
    $('connect').hidden = true;
    setStatus('');
    renderEvents();
  } catch {
    setStatus('Sin conexión — mostrando lo último guardado', false);
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
    list.append(li);
  }

  const remaining = events.some((e) => e.allDay || new Date(e.end) > now);
  $('empty').hidden = remaining || !store.get('events', null);

  const next = $('next');
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
}

function setStatus(text, actionable) {
  const el = $('status');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('warn', !!actionable);
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
  $('settings').showModal();
}

$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const newId = $('client-id').value.trim();
  if (newId !== settings.clientId) {
    tokenClient = null;
    store.remove('token');
  }
  settings.clientId = newId;
  settings.wake = $('wake').checked;
  settings.seconds = $('seconds').checked;
  settings.h24 = $('h24').checked;
  store.set('settings', settings);
  applyWakeLock();
  renderEvents();
  lastFetch = 0;
});

$('disconnect').addEventListener('click', () => {
  const t = store.get('token', null);
  if (t?.value && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.value);
  store.remove('token');
  store.remove('events');
  events = [];
  renderEvents();
  $('settings').close();
  lastFetch = 0;
});

$('settings-btn').addEventListener('click', openSettings);
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
