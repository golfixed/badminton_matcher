import './styles.css';
import type { Player, AppSettings, Rank, TabId, Schedule, Session } from './types';
import { storage } from './storage';
import { generateSchedule, computePlayerStats, countUniquePairs } from './scheduler';
import {
  dbSubscribe, ROOM_ID, isConnected, FIREBASE_READY,
  enterRoom, leaveRoom, writeRoomMeta, deleteRoomMeta, subscribeRoomList, generateRoomId,
  type RoomEntry,
} from './db';

// ─── State ────────────────────────────────────────────────────────────────────

interface AppState {
  players: Player[];
  settings: AppSettings;
  schedule: Schedule | null;
  results: Record<string, 1 | 2>;
  sessions: Session[];
  activeTab: TabId;
  newPlayerName: string;
  newPlayerRank: Rank;
  sessionDate: string;
  sessionLabel: string;
  savedSessionId: string | null;
  expandedSessionId: string | null;
  fontScale: number;
  editingPlayerId: string | null;
  editingName: string;
  editingRank: Rank;
  // Lobby
  inRoom: boolean;
  rooms: RoomEntry[];
  roomsError: string | null;
  newRoomName: string;
  newRoomId: string;
  joinRoomInput: string;
  deleteConfirmRoom: RoomEntry | null;
  currentRoomName: string;
  showCreateModal: boolean;
  showConfirmGenerate: boolean;
}

const FONT_SCALE_KEY = 'bm_fontscale';
const FONT_STEPS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

const state: AppState = {
  players: storage.loadPlayers(),
  settings: storage.loadSettings(),
  schedule: storage.loadSchedule(),
  results: storage.loadResults(),
  sessions: storage.loadSessions(),
  activeTab: 'setup',
  newPlayerName: '',
  newPlayerRank: 'intermediate',
  sessionDate: todayStr(),
  sessionLabel: '',
  savedSessionId: null,
  expandedSessionId: null,
  fontScale: parseFloat(localStorage.getItem(FONT_SCALE_KEY) ?? '1'),
  editingPlayerId: null,
  editingName: '',
  editingRank: 'intermediate',
  inRoom: ROOM_ID !== '',
  rooms: [],
  roomsError: null,
  newRoomName: '',
  deleteConfirmRoom: null,
  newRoomId: generateRoomId(),
  joinRoomInput: '',
  currentRoomName: localStorage.getItem('bm_room_name') ?? '',
  showCreateModal: false,
  showConfirmGenerate: false,
};

function applyZoom(): void {
  const app = document.getElementById('app');
  if (app) app.style.zoom = String(state.fontScale);
}

// ─── Subscription management ─────────────────────────────────────────────────

let _activeUnsubscribers: (() => void)[] = [];
let _lobbyUnsubscribe: () => void = () => { };

function syncAndRender<T>(current: T, incoming: T, update: (v: T) => void): void {
  if (JSON.stringify(incoming) === JSON.stringify(current)) return; // skip own-write echo
  update(incoming);
  renderApp();
}

function setupRoomSubscriptions(): void {
  _activeUnsubscribers.forEach(fn => fn());
  _activeUnsubscribers = [];
  if (!ROOM_ID) return;
  _activeUnsubscribers.push(
    dbSubscribe<Player[]>('bm_players', (v) => syncAndRender(state.players, v, (x) => { state.players = x; })),
    dbSubscribe<AppSettings>('bm_settings', (v) => syncAndRender(state.settings, v, (x) => { state.settings = x; })),
    dbSubscribe<Schedule>('bm_schedule', (v) => syncAndRender(state.schedule, v, (x) => { state.schedule = x; })),
    dbSubscribe<Record<string, 1 | 2>>('bm_results', (v) => syncAndRender(state.results, v, (x) => { state.results = x; })),
    dbSubscribe<Session[]>('bm_sessions', (v) => syncAndRender(state.sessions, v, (x) => { state.sessions = x; })),
  );
}

const ROOM_CACHE_KEYS = ['bm_players', 'bm_settings', 'bm_schedule', 'bm_results', 'bm_sessions'];

function clearRoomCache(): void {
  ROOM_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
}

function enterRoomAndLoad(id: string, name?: string): void {
  _lobbyUnsubscribe();
  _lobbyUnsubscribe = () => { };
  clearRoomCache();
  enterRoom(id);
  if (name && FIREBASE_READY) writeRoomMeta(id, name);
  state.players = storage.loadPlayers();
  state.settings = storage.loadSettings();
  state.schedule = storage.loadSchedule();
  state.results = storage.loadResults();
  state.sessions = storage.loadSessions();
  state.activeTab = 'setup';
  state.inRoom = true;
  state.currentRoomName = name ?? '';
  localStorage.setItem('bm_room_name', name ?? '');
  document.title = (name && name !== id) ? `${name} · Badminton Matcher` : `ห้อง ${id} · Badminton Matcher`;
  state.newRoomName = '';
  state.newRoomId = generateRoomId();
  state.joinRoomInput = '';
  state.showCreateModal = false;
  setupRoomSubscriptions();
  renderApp();
}

function showLobby(): void {
  _activeUnsubscribers.forEach(fn => fn());
  _activeUnsubscribers = [];
  leaveRoom();
  state.inRoom = false;
  state.currentRoomName = '';
  localStorage.removeItem('bm_room_name');
  document.title = 'Badminton Matcher';
  state.newRoomId = generateRoomId();
  _lobbyUnsubscribe();
  _lobbyUnsubscribe = subscribeRoomList((rooms, error) => {
    state.rooms = rooms;
    state.roomsError = error ?? null;
    if (!state.inRoom) renderApp();
  });
  renderApp();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const RANK_LABELS: Record<Rank, string> = {
  beginner: 'Beginner',
  intermediate: 'Inter',
  pro: 'Pro',
};

const RANK_SCORE: Record<Rank, number> = {
  beginner: 1,
  intermediate: 2,
  pro: 3,
};

const MEDALS = ['🥇', '🥈', '🥉'];

function playerName(id: string, players?: Player[]): string {
  return (players ?? state.players).find(p => p.id === id)?.name ?? id;
}

function playerRank(id: string, players?: Player[]): Rank {
  return (players ?? state.players).find(p => p.id === id)?.rank ?? 'beginner';
}

function skillLabel(diff: number): { text: string; cls: string } {
  if (diff === 0) return { text: '⚖ สมดุล', cls: 'skill-balanced' };
  if (diff === 1) return { text: `Δ${diff} พอดี`, cls: 'skill-slight' };
  return { text: `Δ${diff} ต่างกัน`, cls: 'skill-uneven' };
}

function totalRounds(settings: AppSettings): number {
  return Math.floor((settings.hours * 60) / settings.minutesPerMatch);
}

function computeLeaderboardFrom(schedule: Schedule, results: Record<string, 1 | 2>) {
  const stats = new Map<string, { wins: number; losses: number }>();
  schedule.players.forEach(p => stats.set(p.id, { wins: 0, losses: 0 }));
  for (const round of schedule.rounds) {
    for (const match of round.matches) {
      const result = results[match.id];
      if (result === undefined) continue;
      const winners = result === 1 ? match.team1 : match.team2;
      const losers = result === 1 ? match.team2 : match.team1;
      winners.forEach(id => { const s = stats.get(id); if (s) s.wins++; });
      losers.forEach(id => { const s = stats.get(id); if (s) s.losses++; });
    }
  }
  return Array.from(stats.entries())
    .map(([id, s]) => ({ id, ...s, total: s.wins + s.losses }))
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return (b.wins / Math.max(b.total, 1)) - (a.wins / Math.max(a.total, 1));
    });
}

function computeLeaderboard() {
  if (!state.schedule) return [];
  return computeLeaderboardFrom(state.schedule, state.results);
}

function recordedCount(): number {
  return Object.keys(state.results).length;
}

function formatThaiDateShort(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function isCurrentScheduleSaved(): boolean {
  if (!state.schedule) return false;
  return state.sessions.some(s => s.schedule.generatedAt === state.schedule!.generatedAt);
}

// ─── Render ───────────────────────────────────────────────────────────────────

let _resizeTimer: ReturnType<typeof setTimeout>;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(renderApp, 150);
}, { passive: true });

function isWide(): boolean {
  return window.innerWidth >= 1024;
}

function renderApp(): void {
  const app = document.getElementById('app')!;

  // Preserve scroll position before re-render
  const contentEl = document.getElementById('content') as HTMLElement | null;
  const lobbyEl = document.querySelector('.lobby-wrap') as HTMLElement | null;
  const scrollEl = contentEl ?? lobbyEl;
  const scrollTop = scrollEl ? scrollEl.scrollTop : (document.documentElement.scrollTop || document.body.scrollTop);

  if (!state.inRoom) {
    app.innerHTML = renderLobby();
    applyZoom();
    attachLobbyListeners();
    const newLobby = document.querySelector('.lobby-wrap') as HTMLElement | null;
    if (newLobby && scrollTop) requestAnimationFrame(() => { newLobby.scrollTop = scrollTop; });
    return;
  }

  if (isWide()) {
    app.innerHTML = `
      <aside class="sidebar">
        ${renderSidebarBrand()}
        ${renderTabBar()}
      </aside>
      <div class="app-main">
        ${renderTopbar()}
        <div class="content" id="content">${renderActiveTab()}</div>
      </div>
    `;
  } else {
    app.innerHTML = `
      ${renderHeader()}
      <div class="content" id="content">${renderActiveTab()}</div>
      ${renderTabBar()}
    `;
  }
  applyZoom();
  attachEventListeners();
  if (scrollTop) {
    const newContent = document.getElementById('content');
    if (newContent) {
      requestAnimationFrame(() => { newContent.scrollTop = scrollTop; });
    } else {
      requestAnimationFrame(() => { document.documentElement.scrollTop = scrollTop; });
    }
  }
}

function renderSidebarBrand(): string {
  const rec = recordedCount();
  const badge = rec > 0 ? `<span class="sb-badge">${rec} แมตช์</span>` : '';
  const s = dbStatus();
  const roomChip = ROOM_ID ? `<div class="sb-room-chip">ห้อง <strong>${ROOM_ID}</strong></div>` : '';
  return `
    <div class="sidebar-brand">
      <div class="sb-top-row">
        ${ROOM_ID ? `<button class="sb-back-btn" id="btn-back-to-lobby" title="เปลี่ยนห้อง">← ออก</button>` : ''}
      </div>
      <div class="sb-main-row">
        <div class="sidebar-brand-title">${state.currentRoomName || 'Badminton Matcher'}</div>
        <div class="sidebar-brand-sub">${state.players.length} ผู้เล่น · ${state.sessions.length} เซสชัน</div>
      </div>
      <div class="sb-chips-col">
        <div class="sb-status-chip ${s.cls}">
          <span class="conn-dot ${s.dot}"></span>
          <span class="sb-status-label">${s.label}</span>
        </div>
        ${roomChip}
        ${badge}
      </div>
    </div>
  `;
}

function renderTopbar(): string {
  const tabTitles: Record<TabId, string> = {
    setup: 'ผู้เล่น',
    schedule: 'ตารางแข่ง',
    summary: 'คะแนน & Leaderboard',
    history: 'ประวัติเซสชัน',
    help: 'วิธีใช้',
  };
  const deleteBtn = state.schedule
    ? `<button class="topbar-delete-btn" id="btn-delete-schedule" title="ลบตารางแข่ง">🗑️</button>`
    : '';
  return `
    <div class="topbar">
      <div class="topbar-title">${tabTitles[state.activeTab]}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto;">
        ${deleteBtn}
        ${renderFontControls()}
      </div>
    </div>
  `;
}

function renderFontControls(): string {
  const idx = FONT_STEPS.indexOf(state.fontScale);
  const canDown = idx > 0;
  const canUp = idx < FONT_STEPS.length - 1;
  const pct = Math.round(state.fontScale * 100);
  return `
    <div class="font-controls">
      <button class="font-btn" id="btn-font-down" ${!canDown ? 'disabled' : ''} title="ลดขนาด">A−</button>
      <span class="font-pct">${pct}%</span>
      <button class="font-btn" id="btn-font-up" ${!canUp ? 'disabled' : ''} title="เพิ่มขนาด">A+</button>
    </div>
  `;
}

function renderHeader(): string {
  const tabTitles: Record<TabId, string> = {
    setup: 'ผู้เล่น',
    schedule: 'ตารางแข่ง',
    summary: 'คะแนน & Leaderboard',
    history: 'ประวัติเซสชัน',
    help: 'วิธีใช้',
  };
  const rec = recordedCount();
  const badge = rec > 0 ? ` <span class="header-badge">${rec} แมตช์</span>` : '';
  return `
    <header class="header">
      <button class="header-back-btn" id="btn-back-to-lobby" title="กลับ">←</button>
      <div style="flex:1;min-width:0;">
        <div class="header-title">${state.currentRoomName || 'Badminton Matcher'}${badge}</div>
        <div class="header-subtitle">${tabTitles[state.activeTab]}</div>
        ${renderRoomChip('mobile')}
      </div>
      ${renderFontControls()}
    </header>
  `;
}

function dbStatus(): { cls: string; dot: string; label: string; detail: string } {
  if (!FIREBASE_READY) return { cls: 'ds-offline', dot: 'conn-off', label: 'OFFLINE', detail: 'ข้อมูลบันทึกเฉพาะเครื่อง' };
  if (!isConnected) return { cls: 'ds-connecting', dot: 'conn-wait', label: 'กำลังเชื่อมต่อ...', detail: 'รอการเชื่อมต่อ Firebase' };
  return { cls: 'ds-online', dot: 'conn-on', label: 'ONLINE', detail: 'ซิงค์ข้อมูลแบบ Real-time' };
}

function renderDbStatusBadge(): string {
  const s = dbStatus();
  return `
    <div class="db-status-badge ${s.cls}">
      <span class="conn-dot ${s.dot}"></span>
      <div>
        <div class="db-status-label">${s.label}</div>
        <div class="db-status-detail">${s.detail}</div>
      </div>
    </div>
  `;
}

function renderRoomChip(variant: 'mobile' | 'sidebar'): string {
  const s = dbStatus();
  const backBtn = `<button class="room-chip-back" id="btn-back-to-lobby" title="เปลี่ยนห้อง">✕</button>`;
  const roomPart = ROOM_ID ? ` · ห้อง <strong>${ROOM_ID}</strong>` : '';
  if (variant === 'mobile') {
    // No ✕ on mobile — header has a dedicated back button instead
    return `<div class="room-chip-mobile ${s.cls}"><span class="conn-dot ${s.dot}"></span><span class="room-chip-label">${s.label}${roomPart}</span></div>`;
  }
  return `<div class="room-chip-sidebar ${s.cls}"><span class="conn-dot ${s.dot}"></span><span class="room-chip-label">${s.label}${roomPart}</span>${ROOM_ID ? backBtn : ''}</div>`;
}

function renderTabBar(): string {
  const tabs: { id: TabId; icon: string; label: string }[] = [
    { id: 'setup', icon: '👥', label: 'ผู้เล่น' },
    { id: 'schedule', icon: '📋', label: 'ตารางแข่ง' },
    { id: 'summary', icon: '🏆', label: 'คะแนน' },
    { id: 'history', icon: '📅', label: 'ประวัติ' },
    { id: 'help', icon: '📖', label: 'วิธีใช้' },
  ];
  return `
    <nav class="tab-bar">
      ${tabs.map(t => `
        <button class="tab-btn ${state.activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
          <span class="tab-icon">${t.icon}${t.id === 'history' && state.sessions.length > 0
      ? `<span class="tab-count">${state.sessions.length}</span>` : ''}</span>
          <span class="tab-label">${t.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function renderActiveTab(): string {
  switch (state.activeTab) {
    case 'setup': return renderSetupTab();
    case 'schedule': return renderScheduleTab();
    case 'summary': return renderSummaryTab();
    case 'history': return renderHistoryTab();
    case 'help': return renderHelpTab();
  }
}

// ─── Setup Tab ────────────────────────────────────────────────────────────────

function renderConfirmGenerateModal(): string {
  if (!state.showConfirmGenerate) return '';
  const done = recordedCount();
  return `
    <div class="modal-overlay" id="confirm-generate-overlay">
      <div class="modal-box">
        <div class="modal-icon">⚠️</div>
        <div class="modal-title">สร้างตารางแข่งใหม่?</div>
        <div class="modal-body">
          ${done > 0 ? `<p class="modal-warn">ผลที่บันทึกไว้แล้ว <strong>${done} แมตช์</strong> จะ<strong>หายไป</strong>ทั้งหมด</p>` : '<p style="color:var(--text-muted);font-size:13px;">ตารางแข่งเดิมจะถูกแทนที่ด้วยตารางแข่งใหม่</p>'}
        </div>
        <div class="modal-actions">
          <button class="modal-btn-cancel" id="btn-confirm-gen-cancel">ยกเลิก</button>
          <button class="modal-btn-confirm" id="btn-confirm-gen-ok">สร้างใหม่</button>
        </div>
      </div>
    </div>
  `;
}

function renderSetupTab(): string {
  return `
    <div class="setup-layout">
      <div class="setup-col-forms">
        ${renderAddPlayerForm()}
        ${renderSettings()}
        ${renderGenerateButton()}
      </div>
      <div class="setup-col-list">
        ${renderPlayerList()}
      </div>
    </div>
    ${renderConfirmGenerateModal()}
  `;
}

function renderAddPlayerForm(): string {
  return `
    <div class="section">
      <div class="section-title">✏️ เพิ่มผู้เล่น</div>
      <div class="add-form">
        <div class="form-row">
          <div class="form-field">
            <label class="form-label">ชื่อผู้เล่น</label>
            <input
              id="input-name"
              class="form-input"
              type="text"
              placeholder="เช่น นัท, เบสท์ ..."
              value="${escHtml(state.newPlayerName)}"
              maxlength="20"
              autocomplete="off"
            />
          </div>
        </div>
        <div class="rank-selector">
          ${(['beginner', 'intermediate', 'pro'] as Rank[]).map(r => `
            <button class="rank-opt ${state.newPlayerRank === r ? `selected-${r}` : ''}" data-rank="${r}">
              ${RANK_LABELS[r]}
            </button>
          `).join('')}
        </div>
        <div style="margin-top: 10px;">
          <button id="btn-add" class="btn-generate" style="margin-top: 0; padding: 12px;">
            ➕ เพิ่มผู้เล่น
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPlayerList(): string {
  return `
    <div class="section">
      <div class="section-title">👥 ผู้เล่น (${state.players.length} คน)</div>
      ${state.players.length === 0
      ? `<div class="empty-state">
            <div class="empty-icon">🏸</div>
            <div>ยังไม่มีผู้เล่น<br>เพิ่มผู้เล่นอย่างน้อย 4 คนเพื่อสร้างตารางแข่ง</div>
          </div>`
      : `<div class="player-list">
            ${state.players.map((p, i) => {
        if (state.editingPlayerId === p.id) return renderPlayerEditForm(p, i);
        return `
                <div class="player-item" data-id="${p.id}">
                  <span class="player-number">${i + 1}</span>
                  <span class="player-rank-badge rank-${p.rank}">${RANK_LABELS[p.rank]}</span>
                  <span class="player-name">${escHtml(p.name)}</span>
                  <button class="btn-icon btn-edit-player" data-id="${p.id}" title="แก้ไข">✏️</button>
                  <button class="btn-icon btn-remove" data-id="${p.id}" title="ลบ">🗑️</button>
                </div>
              `;
      }).join('')}
          </div>`
    }
    </div>
  `;
}

function renderPlayerEditForm(p: Player, i: number): string {
  return `
    <div class="player-edit-form">
      <span class="player-number">${i + 1}</span>
      <div class="player-edit-body">
        <input id="edit-player-name" class="form-input player-edit-input"
          value="${escHtml(state.editingName)}" maxlength="20" autocomplete="off" />
        <div class="player-edit-ranks">
          ${(['beginner', 'intermediate', 'pro'] as Rank[]).map(r => `
            <button class="rank-opt compact ${state.editingRank === r ? `selected-${r}` : ''}"
              data-edit-rank="${r}">${RANK_LABELS[r]}</button>
          `).join('')}
        </div>
      </div>
      <button class="btn-save-edit" data-id="${p.id}" title="บันทึก">✅</button>
      <button class="btn-cancel-edit" title="ยกเลิก">✕</button>
    </div>
  `;
}

function renderSettings(): string {
  const { courts, hours, minutesPerMatch, useRankMatching = true } = state.settings;
  const rounds = totalRounds(state.settings);
  return `
    <div class="section">
      <div class="section-title">⚙️ ตั้งค่าการแข่ง</div>
      <div class="settings-grid">
        <div class="setting-item">
          <span class="setting-icon">🏟️</span>
          <div class="setting-info">
            <div class="setting-label">จำนวนคอร์ท</div>
            <div class="setting-hint">คอร์ทต่อรอบ</div>
          </div>
          <div class="number-control">
            <button class="num-btn" data-setting="courts" data-delta="-1">−</button>
            <span class="num-value">${courts}</span>
            <button class="num-btn" data-setting="courts" data-delta="1">+</button>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-icon">⏰</span>
          <div class="setting-info">
            <div class="setting-label">ระยะเวลา</div>
            <div class="setting-hint">ชั่วโมง</div>
          </div>
          <div class="number-control">
            <button class="num-btn" data-setting="hours" data-delta="-0.5">−</button>
            <span class="num-value">${hours}h</span>
            <button class="num-btn" data-setting="hours" data-delta="0.5">+</button>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-icon">⏱️</span>
          <div class="setting-info">
            <div class="setting-label">เวลาต่อแมตช์</div>
            <div class="setting-hint">${rounds} รอบ รวม</div>
          </div>
          <div class="number-control">
            <button class="num-btn" data-setting="minutesPerMatch" data-delta="-5">−</button>
            <span class="num-value">${minutesPerMatch}m</span>
            <button class="num-btn" data-setting="minutesPerMatch" data-delta="5">+</button>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-icon">🎯</span>
          <div class="setting-info">
            <div class="setting-label">จับคู่จากระดับผู้เล่น</div>
            <div class="setting-hint">${useRankMatching ? 'คู่แข่งใกล้เคียงกัน' : 'สุ่มโดยไม่คำนึงระดับ'}</div>
          </div>
          <button class="toggle-btn ${useRankMatching ? 'toggle-on' : ''}" id="btn-toggle-rank-matching" aria-pressed="${useRankMatching}">
            <span class="toggle-knob"></span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderGenerateButton(): string {
  const canGenerate = state.players.length >= 4;
  const rounds = totalRounds(state.settings);
  const matches = rounds * state.settings.courts;
  return `
    ${!canGenerate ? `<div class="warning-banner">⚠️ ต้องมีผู้เล่นอย่างน้อย 4 คนจึงจะสร้างตารางแข่งได้</div>` : ''}
    <button id="btn-generate" class="btn-generate" ${!canGenerate ? 'disabled' : ''}>
      🗓️ สร้างตารางแข่ง (${rounds} รอบ, ~${matches} แมตช์)
    </button>
  `;
}

// ─── Schedule Tab ─────────────────────────────────────────────────────────────

function renderScheduleTab(): string {
  if (!state.schedule || state.schedule.rounds.length === 0) {
    return `
      <div class="no-schedule">
        <div class="no-schedule-icon">📋</div>
        <div class="no-schedule-title">ยังไม่มีตารางแข่ง</div>
        <div class="no-schedule-text">กลับไปที่ ผู้เล่น แล้วกด "สร้างตารางแข่ง"</div>
      </div>
    `;
  }
  const done = recordedCount();
  const total = state.schedule.rounds.reduce((s, r) => s + r.matches.length, 0);
  return `
    ${done > 0 ? `<div class="progress-banner">
      ✅ บันทึกผลแล้ว ${done}/${total} แมตช์
      <div class="progress-bar-wrap"><div class="progress-bar" style="width:${Math.round(done / total * 100)}%"></div></div>
    </div>` : ''}
    <div>
      ${state.schedule.rounds.map((round, i) => renderRound(round, i, state.schedule!.rounds.length)).join('')}
    </div>
  `;
}


function renderRound(round: Schedule['rounds'][number], idx: number, total: number): string {
  const doneInRound = round.matches.filter(m => state.results[m.id] !== undefined).length;
  const allDone = doneInRound === round.matches.length;
  return `
    <div class="round-card">
      <div class="round-header">
        <div class="round-title">
          ${allDone ? '✅' : '🎯'} รอบที่ ${round.roundNumber}
          ${allDone ? '<span class="done-tag">จบแล้ว</span>' : doneInRound > 0 ? `<span class="partial-tag">${doneInRound}/${round.matches.length}</span>` : ''}
        </div>
        <div class="round-reorder">
          <button class="round-move-btn" data-move-round="${idx}" data-move-dir="-1" ${idx === 0 ? 'disabled' : ''} title="เลื่อนขึ้น">↑</button>
          <button class="round-move-btn" data-move-round="${idx}" data-move-dir="1" ${idx === total - 1 ? 'disabled' : ''} title="เลื่อนลง">↓</button>
        </div>
        <div class="round-time">🕐 ${round.startTime}</div>
      </div>
      <div class="round-matches">
        ${round.matches.map(match => renderMatch(match)).join('')}
      </div>
      ${(round.resting ?? []).length > 0 ? `
        <div class="resting-section">
          <span class="resting-label">พัก:</span>
          ${(round.resting ?? []).map(id => `<span class="rest-badge">${escHtml(playerName(id))}</span>`).join('')}
        </div>` : ''}
    </div>
  `;
}

function renderMatch(match: Schedule['rounds'][number]['matches'][number]): string {
  const useRank = state.schedule?.settings.useRankMatching ?? true;
  const skill = skillLabel(match.skillDiff);
  const result = state.results[match.id];

  const renderTeam = (ids: [string, string], side: 'left' | 'right') => {
    const align = side === 'right' ? 'style="text-align:right;align-items:flex-end;"' : '';
    const score = useRank ? ids.reduce((s, id) => s + RANK_SCORE[playerRank(id)], 0) : 0;
    return `
      <div class="match-team" ${align}>
        ${ids.map(id => `
          <div class="match-player">
            ${useRank ? `<span class="rank-dot dot-${playerRank(id)}"></span>` : ''}
            <span>${escHtml(playerName(id))}</span>
          </div>
        `).join('')}
        ${useRank ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">⭐ ${score}</div>` : ''}
      </div>
    `;
  };

  const t1Won = result === 1;
  const t2Won = result === 2;
  const hasResult = result !== undefined;

  const btn1Class = t1Won ? 'result-btn winner' : hasResult ? 'result-btn loser' : 'result-btn unset';
  const btn2Class = t2Won ? 'result-btn winner' : hasResult ? 'result-btn loser' : 'result-btn unset';
  const btn1Text = t1Won ? '🏆 ชนะ' : hasResult ? 'แพ้' : '👈 ทีมซ้าย';
  const btn2Text = t2Won ? '🏆 ชนะ' : hasResult ? 'แพ้' : 'ทีมขวา 👉';

  return `
    <div class="match-card ${hasResult ? 'match-done' : ''}">
      <div class="match-court-label">คอร์ท ${match.court}</div>
      <div class="match-teams">
        ${renderTeam(match.team1, 'left')}
        <div class="match-vs">
          <div class="vs-label">VS</div>
          ${useRank ? `<div class="skill-badge ${skill.cls}">${skill.text}</div>` : ''}
        </div>
        ${renderTeam(match.team2, 'right')}
      </div>
      <div class="result-row">
        <button class="${btn1Class}" data-match-result="${match.id}" data-team="1">${btn1Text}</button>
        <button class="${btn2Class}" data-match-result="${match.id}" data-team="2">${btn2Text}</button>
        ${hasResult ? `<button class="result-btn reset" data-match-reset="${match.id}" title="รีเซ็ต">↺</button>` : ''}
      </div>
    </div>
  `;
}

// ─── Summary / Leaderboard Tab ────────────────────────────────────────────────

function renderSummaryTab(): string {
  if (!state.schedule || state.schedule.rounds.length === 0) {
    return `
      <div class="no-schedule">
        <div class="no-schedule-icon">🏆</div>
        <div class="no-schedule-title">ยังไม่มีข้อมูล</div>
        <div class="no-schedule-text">กลับไปที่ ผู้เล่น แล้วกด "สร้างตารางแข่ง"</div>
      </div>
    `;
  }

  const schedule = state.schedule;
  const leaderboard = computeLeaderboard();
  const hasResults = recordedCount() > 0;
  const statsMap = computePlayerStats(schedule);
  const pairCoverage = countUniquePairs(schedule);
  const totalMatchCount = schedule.rounds.reduce((s, r) => s + r.matches.length, 0);
  const covPct = Math.round((pairCoverage.played / Math.max(pairCoverage.total, 1)) * 100);
  const balancedCount = schedule.rounds.flatMap(r => r.matches).filter(m => m.skillDiff === 0).length;
  const balancePct = Math.round((balancedCount / Math.max(totalMatchCount, 1)) * 100);
  const alreadySaved = isCurrentScheduleSaved();

  const statsSection = `
    <div class="summary-stats" style="margin-top:16px;">
      <div class="stat-card"><div class="stat-value">${schedule.rounds.length}</div><div class="stat-label">รอบทั้งหมด</div></div>
      <div class="stat-card"><div class="stat-value">${totalMatchCount}</div><div class="stat-label">แมตช์ทั้งหมด</div></div>
      <div class="stat-card"><div class="stat-value">${covPct}%</div><div class="stat-label">คู่ที่ได้เล่น</div></div>
      <div class="stat-card"><div class="stat-value">${balancePct}%</div><div class="stat-label">Balanced Match</div></div>
    </div>
    <div class="coverage-card">
      <div class="coverage-title">📈 Pair Coverage</div>
      <div class="coverage-bar-wrap"><div class="coverage-bar" style="width:${covPct}%"></div></div>
      <div class="coverage-text">${pairCoverage.played} / ${pairCoverage.total} คู่ (${covPct}%)</div>
    </div>
    <div class="section">
      <div class="section-title">👤 สถิติผู้เล่น</div>
      <div class="stats-table">
        <div class="stats-header">
          <div class="stats-col-header">ผู้เล่น</div>
          <div class="stats-col-header">แมตช์</div>
          <div class="stats-col-header">พัก</div>
          <div class="stats-col-header">คู่</div>
        </div>
        ${schedule.players.map(p => {
    const s = statsMap.get(p.id)!;
    return `
            <div class="stats-row">
              <div>
                <div class="stats-player-name">${escHtml(p.name)}</div>
                <div class="stats-player-sub">
                  <span class="player-rank-badge rank-${p.rank}" style="font-size:10px;padding:2px 6px;">${RANK_LABELS[p.rank]}</span>
                </div>
              </div>
              <div class="stats-cell">${s.matchesPlayed}</div>
              <div class="stats-cell rest">${s.restRounds}</div>
              <div class="stats-cell"><div>${s.partners.size}</div><div class="coverage-mini">opp: ${s.opponents.size}</div></div>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;

  return `
    <div class="summary-page">
      ${hasResults ? renderLeaderboard(leaderboard) : `
        <div class="warning-banner">📋 เริ่มบันทึกผลการแข่งในหน้า ตารางแข่ง เพื่อดู Leaderboard</div>
      `}
      ${renderSaveSessionCard(alreadySaved)}
      ${statsSection}
      ${renderMatchHistory()}
    </div>
  `;
}

function renderSaveSessionCard(alreadySaved: boolean): string {
  if (alreadySaved) {
    return `
      <div class="save-session-card saved">
        <div class="save-session-saved-icon">✅</div>
        <div>
          <div class="save-session-saved-title">บันทึกเซสชันนี้แล้ว</div>
          <div class="save-session-saved-sub">ดูได้ที่แท็บ ประวัติ</div>
        </div>
        <button class="save-session-view-btn" data-tab-go="history">ดูประวัติ →</button>
      </div>
    `;
  }

  const done = recordedCount();
  const total = state.schedule?.rounds.reduce((s, r) => s + r.matches.length, 0) ?? 0;

  return `
    <div class="save-session-card">
      <div class="save-session-title">💾 บันทึกเซสชัน</div>
      <div class="save-session-meta">${done}/${total} แมตช์บันทึกผลแล้ว · ${state.schedule?.players.length ?? 0} ผู้เล่น</div>
      <div class="save-form-row">
        <div class="save-form-group">
          <label class="form-label">วันที่แข่ง</label>
          <input id="session-date" class="form-input" type="date" value="${state.sessionDate}" />
        </div>
        <div class="save-form-group" style="flex:2">
          <label class="form-label">บันทึก (ไม่บังคับ)</label>
          <input id="session-label" class="form-input" type="text"
            placeholder="เช่น ฝึกซ้อมวันเสาร์"
            value="${escHtml(state.sessionLabel)}" maxlength="40" />
        </div>
      </div>
      <button id="btn-save-session" class="btn-save-session">
        💾 บันทึกเซสชัน
      </button>
    </div>
  `;
}

function renderPodiumSpot(
  entry: ReturnType<typeof computeLeaderboard>[number] | undefined,
  pos: 1 | 2 | 3,
  players?: Player[]
): string {
  const pls = players ?? state.players;
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' } as const;
  const blockClass = { 1: 'podium-gold', 2: 'podium-silver', 3: 'podium-bronze' } as const;

  if (!entry) {
    return `
      <div class="podium-col ${pos === 1 ? 'podium-champion' : ''}">
        <div class="podium-info podium-empty"><span>—</span></div>
        <div class="podium-block ${blockClass[pos]}">${pos}</div>
      </div>`;
  }

  const winRate = entry.total === 0 ? 0 : Math.round((entry.wins / entry.total) * 100);

  return `
    <div class="podium-col ${pos === 1 ? 'podium-champion' : ''}">
      <div class="podium-info">
        <div class="podium-medal">${medals[pos]}</div>
        <div class="podium-pname">${escHtml(playerName(entry.id, pls))}</div>
        <div class="podium-record">${entry.wins}W ${entry.losses}L · ${winRate}%</div>
      </div>
      <div class="podium-block ${blockClass[pos]}">${pos}</div>
    </div>`;
}

function renderLeaderboard(board: ReturnType<typeof computeLeaderboard>, players?: Player[]): string {
  if (board.length === 0) return '';
  const pls = players ?? state.players;
  const top3 = board.slice(0, 3);
  const rest = board.slice(3);
  const leftMax = 4; // podium(3) + 4 rows = 7 players on left
  const leftRows = rest.slice(0, leftMax);
  const rightRows = rest.slice(leftMax);

  const renderRow = (entry: typeof board[number], pos: number) => {
    const winRate = entry.total === 0 ? 0 : Math.round((entry.wins / entry.total) * 100);
    return `
      <div class="lb-row">
        <div class="lb-medal">#${pos}</div>
        <div class="lb-info">
          <div class="lb-name">${escHtml(playerName(entry.id, pls))}</div>
        </div>
        <div class="lb-stats">
          <div class="lb-record">
            <span class="lb-win">${entry.wins}W</span>
            <span class="lb-loss">${entry.losses}L</span>
          </div>
          <div class="lb-rate-wrap"><div class="lb-rate-bar" style="width:${winRate}%"></div></div>
          <div class="lb-pct">${entry.total === 0 ? '—' : `${winRate}%`}</div>
        </div>
      </div>`;
  };

  return `
    <div class="section">
      <div class="lb-split-card">
        <div class="lb-split-left">
          <div class="podium-stage">
            ${renderPodiumSpot(top3[1], 2, pls)}
            ${renderPodiumSpot(top3[0], 1, pls)}
            ${renderPodiumSpot(top3[2], 3, pls)}
          </div>
          ${leftRows.length > 0 ? `<div class="lb-split-list">${leftRows.map((e, i) => renderRow(e, i + 4)).join('')}</div>` : ''}
        </div>
        <div class="lb-split-right">
          ${rightRows.length > 0 ? `<div class="lb-split-list">${rightRows.map((e, i) => renderRow(e, i + 4 + leftMax)).join('')}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderMatchHistory(schedule?: Schedule, results?: Record<string, 1 | 2>, players?: Player[]): string {
  const sch = schedule ?? state.schedule;
  const res = results ?? state.results;
  const pls = players ?? state.players;
  if (!sch || Object.keys(res).length === 0) return '';

  const rows: string[] = [];
  for (const round of sch.rounds) {
    for (const match of round.matches) {
      const result = res[match.id];
      if (result === undefined) continue;
      const winners = result === 1 ? match.team1 : match.team2;
      const losers = result === 1 ? match.team2 : match.team1;
      rows.push(`
        <div class="history-row">
          <div class="history-meta">รอบ ${round.roundNumber} · Court ${match.court} · ${round.startTime}</div>
          <div class="history-result">
            <span class="history-winner">🏆 ${winners.map(id => escHtml(playerName(id, pls))).join(' + ')}</span>
            <span class="history-vs">ชนะ</span>
            <span class="history-loser">${losers.map(id => escHtml(playerName(id, pls))).join(' + ')}</span>
          </div>
        </div>
      `);
    }
  }
  if (rows.length === 0) return '';

  return `
    <div class="section">
      <div class="section-title">📜 ประวัติแมตช์ (${rows.length} แมตช์)</div>
      <div class="history-list">${rows.join('')}</div>
    </div>
  `;
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function renderHistoryTab(): string {
  if (state.sessions.length === 0) {
    return `
      <div class="no-schedule">
        <div class="no-schedule-icon">📅</div>
        <div class="no-schedule-title">ยังไม่มีประวัติ</div>
        <div class="no-schedule-text">บันทึกเซสชันได้จากหน้า คะแนน หลังจากแข่งเสร็จ</div>
      </div>
    `;
  }

  const sorted = [...state.sessions].sort((a, b) => b.savedAt - a.savedAt);

  return `
    <div>
      <div class="section-title" style="margin-bottom:12px;">
        📅 ประวัติทั้งหมด (${sorted.length} เซสชัน)
      </div>
      <div class="history-grid">
        ${sorted.map(session => renderSessionCard(session)).join('')}
      </div>
    </div>
  `;
}

function renderSessionCard(session: Session): string {
  const board = computeLeaderboardFrom(session.schedule, session.results);
  const top3 = board.slice(0, 3);
  const done = Object.keys(session.results).length;
  const total = session.schedule.rounds.reduce((s, r) => s + r.matches.length, 0);
  const isExpanded = state.expandedSessionId === session.id;

  const labelLine = session.label
    ? `<div class="session-label">"${escHtml(session.label)}"</div>` : '';

  const top3Html = top3.map((e, i) => {
    const r = session.schedule.players.find(p => p.id === e.id)?.rank ?? 'beginner';
    const total = e.wins + e.losses;
    const pct = total === 0 ? 0 : Math.round((e.wins / total) * 100);
    return `
      <div class="session-lb-row">
        <span class="session-lb-medal">${MEDALS[i] ?? `#${i + 1}`}</span>
        <span class="session-lb-name">${escHtml(playerName(e.id, session.schedule.players))}</span>
        <span class="player-rank-badge rank-${r}" style="font-size:10px;padding:1px 5px;">${RANK_LABELS[r as Rank]}</span>
        <span class="session-lb-stats">${e.wins}W ${e.losses}L · ${pct}%</span>
      </div>
    `;
  }).join('');

  const expandedContent = isExpanded ? `
    <div class="session-expanded">
      ${renderLeaderboardCompact(board, session.schedule.players)}
      ${renderMatchHistory(session.schedule, session.results, session.schedule.players)}
    </div>
  ` : '';

  return `
    <div class="session-card">
      <div class="session-header">
        <div class="session-date-block">
          <div class="session-date">${formatThaiDateShort(session.date)}</div>
          <div class="session-time">บันทึกเมื่อ ${formatTime(session.savedAt)}</div>
        </div>
        <button class="btn-icon btn-delete-session" data-session-id="${session.id}" title="ลบ">🗑️</button>
      </div>
      ${labelLine}
      <div class="session-meta-row">
        <span class="session-chip">👥 ${session.schedule.players.length} คน</span>
        <span class="session-chip">📋 ${done}/${total} แมตช์</span>
        <span class="session-chip">🏟 ${session.schedule.settings.courts} คอร์ท</span>
      </div>
      ${done > 0 ? `
        <div class="session-top3">${top3Html}</div>
      ` : `<div class="session-no-results">ไม่มีผลการแข่ง</div>`}
      <button class="session-expand-btn" data-session-expand="${session.id}">
        ${isExpanded ? '▲ ย่อ' : '▼ ดูรายละเอียด'}
      </button>
      ${expandedContent}
    </div>
  `;
}

function renderLeaderboardCompact(board: ReturnType<typeof computeLeaderboard>, players: Player[]): string {
  if (board.length === 0) return '';
  return `
    <div class="section" style="margin-top:12px;">
      <div class="section-title">🏆 Leaderboard</div>
      <div class="leaderboard">
        ${board.map((entry, i) => {
    const total = entry.wins + entry.losses;
    const winRate = total === 0 ? 0 : Math.round((entry.wins / total) * 100);
    const medal = MEDALS[i] ?? `#${i + 1}`;
    const rank = players.find(p => p.id === entry.id)?.rank ?? 'beginner';
    return `
            <div class="lb-row ${i === 0 ? 'lb-gold' : i === 1 ? 'lb-silver' : i === 2 ? 'lb-bronze' : ''}">
              <div class="lb-medal">${medal}</div>
              <div class="lb-info">
                <div class="lb-name">${escHtml(playerName(entry.id, players))}</div>
                <div class="lb-rank-badge rank-${rank}">${RANK_LABELS[rank as Rank]}</div>
              </div>
              <div class="lb-stats">
                <div class="lb-record">
                  <span class="lb-win">${entry.wins}W</span>
                  <span class="lb-loss">${entry.losses}L</span>
                </div>
                <div class="lb-rate-wrap"><div class="lb-rate-bar" style="width:${winRate}%"></div></div>
                <div class="lb-pct">${total === 0 ? '—' : `${winRate}%`}</div>
              </div>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

function renderDeleteRoomModal(): string {
  const room = state.deleteConfirmRoom;
  if (!room) return '';
  return `
    <div class="modal-overlay" id="delete-room-modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">🗑️</div>
        <div class="modal-title">ลบห้องนี้?</div>
        <div class="modal-body">
          <div class="modal-room-name">${escHtml(room.name)}</div>
          <code class="modal-room-id">${room.id}</code>
          <p class="modal-warn">ข้อมูลในห้อง (ผู้เล่น, ตารางแข่ง, ผลแข่ง) จะ<strong>ไม่</strong>ถูกลบ<br>แต่ห้องนี้จะหายออกจากรายการ</p>
        </div>
        <div class="modal-actions">
          <button class="modal-btn-cancel" id="btn-delete-room-cancel">ยกเลิก</button>
          <button class="modal-btn-confirm" id="btn-delete-room-confirm" data-confirm-room-id="${room.id}">ลบห้อง</button>
        </div>
      </div>
    </div>
  `;
}

function renderCreateRoomModal(): string {
  if (!state.showCreateModal) return '';
  return `
    <div class="modal-overlay" id="create-room-modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">🏸</div>
        <div class="modal-title">สร้างห้องใหม่</div>
        <div class="modal-body">
          <div class="form-field" style="margin-bottom:12px;">
            <label class="form-label">ชื่อห้อง (ไม่บังคับ)</label>
            <input id="lobby-room-name" class="form-input" type="text"
              placeholder="เช่น ห้องแข่งวันเสาร์" maxlength="30"
              value="${escHtml(state.newRoomName)}" autocomplete="off" />
          </div>
          <div class="lobby-id-row">
            <span class="lobby-id-label">รหัสห้อง</span>
            <code class="lobby-id-code">${state.newRoomId}</code>
            <button class="lobby-shuffle-btn" id="btn-shuffle-room-id" title="สุ่มรหัสใหม่">🔀</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn-cancel" id="btn-create-room-cancel">ยกเลิก</button>
          <button class="modal-btn-create" id="btn-create-room">✅ สร้างและเข้าห้อง</button>
        </div>
      </div>
    </div>
  `;
}

function renderLobby(): string {
  return `
    <div class="lobby-wrap">
      <div class="lobby-header">
        <div class="lobby-logo">🏸</div>
        <div class="lobby-title">Badminton Matcher</div>
        <div class="lobby-sub">เลือกหรือสร้างห้องแข่งขัน</div>
        ${renderDbStatusBadge()}
      </div>

      <div class="lobby-body">
        ${FIREBASE_READY ? renderLobbyRoomList() : ''}

        <div class="lobby-card">
          <div class="lobby-card-title">🔗 เข้าห้องด้วยรหัส</div>
          <div class="lobby-join-row">
            <input id="lobby-join-input" class="form-input lobby-join-input"
              type="text" placeholder="ABC123" maxlength="6"
              value="${escHtml(state.joinRoomInput)}"
              autocomplete="off" autocorrect="off" spellcheck="false" />
            <button class="lobby-join-btn" id="btn-join-room">เข้าห้อง →</button>
          </div>
        </div>

        <button class="btn-generate lobby-create-btn" id="btn-open-create-room">
          ➕ สร้างห้องใหม่
        </button>
      </div>
    </div>
    ${renderDeleteRoomModal()}
    ${renderCreateRoomModal()}
  `;
}

function renderLobbyRoomList(): string {
  if (state.roomsError) {
    const isPermission = state.roomsError.toLowerCase().includes('permission');
    return `
      <div class="lobby-card lobby-card-error">
        <div class="lobby-card-title">📋 ห้องทั้งหมด</div>
        <div class="lobby-rules-error">
          <div class="lobby-rules-icon">⚠️</div>
          <div>
            <div class="lobby-rules-title">${isPermission ? 'Firebase Rules ยังไม่อนุญาต' : 'ไม่สามารถโหลดรายการห้องได้'}</div>
            ${isPermission ? `
              <div class="lobby-rules-steps">
                <div>แก้ไขที่ Firebase Console → Realtime Database → Rules</div>
                <pre class="lobby-rules-code">{
  "rules": {
    ".read": true,
    ".write": true
  }
}</pre>
              </div>
            ` : `<div class="lobby-rules-detail">${state.roomsError}</div>`}
          </div>
        </div>
      </div>
    `;
  }
  if (state.rooms.length === 0) {
    return `
      <div class="lobby-card">
        <div class="lobby-card-title">📋 ห้องทั้งหมด</div>
        <div class="lobby-empty">ยังไม่มีห้อง — สร้างห้องแรกได้เลย!</div>
      </div>
    `;
  }
  return `
    <div class="lobby-card">
      <div class="lobby-card-title">📋 ห้องทั้งหมด (${state.rooms.length})</div>
      <div class="lobby-room-list">
        ${state.rooms.map(room => `
          <div class="lobby-room-row">
            <div class="lobby-room-info">
              <div class="lobby-room-name">${escHtml(room.name)}</div>
              <code class="lobby-room-id-chip">${room.id}</code>
            </div>
            <div class="lobby-room-actions">
              <button class="lobby-enter-btn" data-enter-room="${room.id}" data-enter-room-name="${escHtml(room.name)}">เข้า →</button>
              <button class="lobby-more-btn" data-delete-room-id="${room.id}" data-delete-room-name="${escHtml(room.name)}" title="จัดการห้อง">···</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function attachLobbyListeners(): void {
  // Open create room modal
  document.getElementById('btn-open-create-room')?.addEventListener('click', () => {
    state.showCreateModal = true;
    renderApp();
  });

  // Close create room modal
  const closeCreateModal = () => { state.showCreateModal = false; renderApp(); };
  document.getElementById('btn-create-room-cancel')?.addEventListener('click', closeCreateModal);
  document.getElementById('create-room-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCreateModal();
  });

  document.getElementById('lobby-room-name')?.addEventListener('input', (e) => {
    state.newRoomName = (e.target as HTMLInputElement).value;
  });

  document.getElementById('btn-shuffle-room-id')?.addEventListener('click', () => {
    state.newRoomId = generateRoomId();
    renderApp();
  });

  document.getElementById('btn-create-room')?.addEventListener('click', () => {
    enterRoomAndLoad(state.newRoomId, state.newRoomName || state.newRoomId);
  });

  const joinInput = document.getElementById('lobby-join-input') as HTMLInputElement | null;
  if (joinInput) {
    joinInput.addEventListener('input', () => {
      state.joinRoomInput = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      joinInput.value = state.joinRoomInput;
    });
    joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoinRoom(); });
  }

  document.getElementById('btn-join-room')?.addEventListener('click', doJoinRoom);

  document.querySelectorAll<HTMLButtonElement>('[data-enter-room]').forEach(btn => {
    btn.addEventListener('click', () => {
      enterRoomAndLoad(btn.dataset.enterRoom!, btn.dataset.enterRoomName);
    });
  });

  // Open delete confirm modal
  document.querySelectorAll<HTMLButtonElement>('[data-delete-room-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.deleteConfirmRoom = {
        id: btn.dataset.deleteRoomId!,
        name: btn.dataset.deleteRoomName!,
        createdAt: 0,
      };
      renderApp();
    });
  });

  // Confirm delete
  document.getElementById('btn-delete-room-confirm')?.addEventListener('click', (e) => {
    const id = (e.currentTarget as HTMLButtonElement).dataset.confirmRoomId!;
    deleteRoomMeta(id);
    state.deleteConfirmRoom = null;
    // room list will update via Firebase subscription
  });

  // Cancel delete (button or overlay click)
  const closeModal = () => { state.deleteConfirmRoom = null; renderApp(); };
  document.getElementById('btn-delete-room-cancel')?.addEventListener('click', closeModal);
  document.getElementById('delete-room-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

function doJoinRoom(): void {
  const id = state.joinRoomInput.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(id)) {
    const el = document.getElementById('lobby-join-input') as HTMLInputElement | null;
    if (el) { el.style.borderColor = 'var(--danger)'; setTimeout(() => (el.style.borderColor = ''), 1000); }
    return;
  }
  enterRoomAndLoad(id);
}

// ─── Help Tab ─────────────────────────────────────────────────────────────────

function renderHelpTab(): string {
  const roomSection = FIREBASE_READY ? `
    <div class="help-section">
      <div class="help-section-title">🔗 การแชร์ห้อง (Room Sharing)</div>
      <div class="help-section-body">
        <p>แอปนี้ใช้ระบบ <strong>ห้อง (Room)</strong> เพื่อให้ทุกคนในกลุ่มเห็นข้อมูลเดียวกันแบบ Real-time
        โดยไม่ต้องลงทะเบียน</p>
        <ul>
          <li>แต่ละกลุ่มจะได้รหัสห้อง 6 ตัวอักษร เช่น <code>${ROOM_ID}</code></li>
          <li>แชร์ URL นี้ให้เพื่อนในกลุ่ม แล้วทุกคนจะเห็นข้อมูลเดียวกัน</li>
          <li>ถ้าอยากเริ่มห้องใหม่ ให้ลบรหัสออกจาก URL แล้วโหลดหน้าใหม่</li>
        </ul>
        <button class="help-copy-btn" id="btn-copy-room">📋 คัดลอกลิงก์ห้องนี้</button>
      </div>
    </div>
  ` : '';

  return `
    <div class="help-content">

      <div class="help-section">
        <div class="help-section-title">🚀 วิธีเริ่มต้นใช้งาน</div>
        <div class="help-section-body">
          <ol>
            <li>ไปที่แท็บ <strong>ผู้เล่น</strong> แล้วเพิ่มผู้เล่นอย่างน้อย 4 คน</li>
            <li>ผู้เล่นจำนวนคอร์ท ระยะเวลา และเวลาต่อแมตช์</li>
            <li>กด <strong>"สร้างตารางแข่ง"</strong> เพื่อสร้างตารางแข่งขัน</li>
            <li>ไปที่แท็บ <strong>ตารางแข่ง</strong> เพื่อดูการจับคู่แต่ละรอบ</li>
            <li>บันทึกผลชนะ-แพ้ในแต่ละแมตช์</li>
            <li>ดู Leaderboard ได้ที่แท็บ <strong>คะแนน</strong></li>
            <li>บันทึกผลเซสชันไว้ดูย้อนหลังได้ที่แท็บ <strong>ประวัติ</strong></li>
          </ol>
        </div>
      </div>

      <div class="help-section">
        <div class="help-section-title">👤 ระดับผู้เล่น (Rank)</div>
        <div class="help-section-body">
          <p>แต่ละผู้เล่นมีระดับที่ใช้คำนวณความสมดุลของคู่แข่ง:</p>
          <div class="help-rank-list">
            <div class="help-rank-row">
              <span class="player-rank-badge rank-beginner">Beginner</span>
              <span>คะแนน 1 — ผู้เริ่มต้น</span>
            </div>
            <div class="help-rank-row">
              <span class="player-rank-badge rank-intermediate">Inter</span>
              <span>คะแนน 2 — ระดับกลาง</span>
            </div>
            <div class="help-rank-row">
              <span class="player-rank-badge rank-pro">Pro</span>
              <span>คะแนน 3 — ระดับสูง</span>
            </div>
          </div>
        </div>
      </div>

      <div class="help-section">
        <div class="help-section-title">🔀 วิธีการจับคู่ (Matching Algorithm)</div>
        <div class="help-section-body">
          <p>ระบบจะพยายามจัดตารางแข่งให้ดีที่สุดโดยใช้เกณฑ์ต่อไปนี้:</p>
          <ul>
            <li><strong>ลดซ้ำเป็นคู่</strong> — พยายามให้ผู้เล่นจับคู่กับคนต่างๆ ให้มากที่สุด</li>
            <li><strong>ลดซ้ำเป็นคู่แข่ง</strong> — พยายามหลีกเลี่ยงการเจอหน้ากันซ้ำๆ</li>
            <li><strong>สมดุล Skill</strong> — คำนวณความต่างของคะแนนรวมสองฝั่ง (Δ=0 คือ Balanced)</li>
            <li><strong>หมุนเวียนพัก</strong> — เมื่อผู้เล่นเกินคอร์ท จะสลับให้แต่ละคนพักอย่างยุติธรรม</li>
          </ul>
          <div class="help-tip">
            💡 <strong>Skill Diff (Δ)</strong>: Δ0 = Balanced · Δ1 = Fair · Δ2+ = Uneven
          </div>
        </div>
      </div>

      <div class="help-section">
        <div class="help-section-title">🏆 การนับคะแนน (Leaderboard)</div>
        <div class="help-section-body">
          <p>คะแนนใน Leaderboard นับจากผลบันทึกในแต่ละแมตช์:</p>
          <ul>
            <li>เลือกฝั่งที่ชนะในปุ่ม <strong>ทีมซ้าย / ทีมขวา</strong></li>
            <li>ทุกคนในทีมชนะได้ +1 Win, ทุกคนในทีมแพ้ได้ +1 Loss</li>
            <li>จัดอันดับโดย <strong>จำนวน Win</strong> มากที่สุดก่อน</li>
            <li>ถ้า Win เท่ากัน จะดูจาก <strong>Win Rate (%)</strong></li>
          </ul>
          <div class="help-tip">
            💡 กด <strong>↺</strong> เพื่อยกเลิกผลแมตช์ที่บันทึกผิด
          </div>
        </div>
      </div>

      ${roomSection}

    </div>
  `;
}

// ─── Event Handling ───────────────────────────────────────────────────────────

function doGenerateSchedule(): void {
  state.schedule = generateSchedule(state.players, state.settings);
  state.results = {};
  state.savedSessionId = null;
  storage.saveSchedule(state.schedule);
  storage.clearResults();
  state.activeTab = 'schedule';
  renderApp();
}

function attachEventListeners(): void {
  // Font size
  document.getElementById('btn-font-down')?.addEventListener('click', () => {
    const idx = FONT_STEPS.indexOf(state.fontScale);
    if (idx > 0) {
      state.fontScale = FONT_STEPS[idx - 1];
      localStorage.setItem(FONT_SCALE_KEY, String(state.fontScale));
      applyZoom();
      // Update controls in place without full re-render
      const wrap = document.querySelector<HTMLElement>('.font-controls');
      if (wrap) wrap.outerHTML; // force re-render via renderApp
      renderApp();
    }
  });
  document.getElementById('btn-font-up')?.addEventListener('click', () => {
    const idx = FONT_STEPS.indexOf(state.fontScale);
    if (idx < FONT_STEPS.length - 1) {
      state.fontScale = FONT_STEPS[idx + 1];
      localStorage.setItem(FONT_SCALE_KEY, String(state.fontScale));
      applyZoom();
      renderApp();
    }
  });

  document.getElementById('btn-delete-schedule')?.addEventListener('click', () => {
    if (!confirm('ลบตารางแข่งปัจจุบัน? ผลการแข่งทั้งหมดจะถูกลบด้วย')) return;
    state.schedule = null;
    state.results = {};
    storage.clearSchedule();
    storage.clearResults();
    state.activeTab = 'setup';
    renderApp();
  });

  // Edit player
  document.querySelectorAll<HTMLButtonElement>('.btn-edit-player').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = state.players.find(p => p.id === btn.dataset.id);
      if (!p) return;
      state.editingPlayerId = p.id;
      state.editingName = p.name;
      state.editingRank = p.rank;
      renderApp();
    });
  });

  // Edit rank selector
  document.querySelectorAll<HTMLButtonElement>('[data-edit-rank]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.editingRank = btn.dataset.editRank as Rank;
      document.querySelectorAll<HTMLButtonElement>('[data-edit-rank]').forEach(b => {
        const r = b.dataset.editRank as Rank;
        b.className = `rank-opt compact ${state.editingRank === r ? `selected-${r}` : ''}`;
      });
    });
  });

  // Save edit
  document.querySelectorAll<HTMLButtonElement>('.btn-save-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const nameEl = document.getElementById('edit-player-name') as HTMLInputElement | null;
      const name = (nameEl?.value ?? state.editingName).trim();
      if (!name) return;
      state.players = state.players.map(p =>
        p.id === btn.dataset.id ? { ...p, name, rank: state.editingRank } : p
      );
      storage.savePlayers(state.players);
      state.editingPlayerId = null;
      renderApp();
    });
  });

  // Cancel edit
  document.querySelector<HTMLButtonElement>('.btn-cancel-edit')?.addEventListener('click', () => {
    state.editingPlayerId = null;
    renderApp();
  });

  // Edit name input
  const editNameInput = document.getElementById('edit-player-name') as HTMLInputElement | null;
  if (editNameInput) {
    editNameInput.addEventListener('input', () => { state.editingName = editNameInput.value; });
    editNameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.querySelector<HTMLButtonElement>('.btn-save-edit')?.click();
      if (e.key === 'Escape') { state.editingPlayerId = null; renderApp(); }
    });
    editNameInput.focus();
    editNameInput.select();
  }

  // Back to lobby
  document.getElementById('btn-back-to-lobby')?.addEventListener('click', showLobby);

  // Copy room link
  document.getElementById('btn-copy-room')?.addEventListener('click', async () => {
    const url = `${window.location.origin}${window.location.pathname}#${ROOM_ID}`;
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('btn-copy-room');
      if (btn) { btn.textContent = '✅ คัดลอกแล้ว!'; setTimeout(() => { btn.textContent = '📋 คัดลอกลิงก์ห้องนี้'; }, 2000); }
    } catch { /* ignore */ }
  });

  // Tab switching
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab as TabId;
      renderApp();
    });
  });

  // Tab-go buttons (e.g., "ดูประวัติ →" inside summary)
  document.querySelectorAll<HTMLButtonElement>('[data-tab-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tabGo as TabId;
      renderApp();
    });
  });

  // Name input sync
  const nameInput = document.getElementById('input-name') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.addEventListener('input', () => { state.newPlayerName = nameInput.value; });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPlayer(); });
  }

  // Rank selector
  document.querySelectorAll<HTMLButtonElement>('[data-rank]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.newPlayerRank = btn.dataset.rank as Rank;
      document.querySelectorAll<HTMLButtonElement>('[data-rank]').forEach(b => {
        const r = b.dataset.rank as Rank;
        b.className = `rank-opt ${state.newPlayerRank === r ? `selected-${r}` : ''}`;
      });
    });
  });

  // Add player
  document.getElementById('btn-add')?.addEventListener('click', addPlayer);

  // Remove player
  document.querySelectorAll<HTMLButtonElement>('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.players = state.players.filter(p => p.id !== btn.dataset.id);
      storage.savePlayers(state.players);
      renderApp();
    });
  });

  // Settings number controls
  document.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.setting as keyof AppSettings;
      const delta = parseFloat(btn.dataset.delta ?? '0');
      const limits: Partial<Record<keyof AppSettings, [number, number]>> = {
        courts: [1, 10], hours: [0.5, 12], minutesPerMatch: [5, 60],
      };
      if (!(key in limits)) return;
      const [min, max] = limits[key]!;
      const next = Math.min(max, Math.max(min, (state.settings[key] as number) + delta));
      state.settings = { ...state.settings, [key]: Math.round(next * 10) / 10 };
      storage.saveSettings(state.settings);

      // Patch DOM in-place (no full re-render = no scroll jump)
      const ctrl = btn.closest('.number-control');
      const valSpan = ctrl?.querySelector('.num-value');
      if (valSpan) {
        const v = state.settings[key];
        valSpan.textContent = key === 'hours' ? `${v}h` : key === 'minutesPerMatch' ? `${v}m` : String(v);
      }
      // Update disabled states
      ctrl?.querySelectorAll<HTMLButtonElement>('.num-btn').forEach(b => {
        const d = parseFloat(b.dataset.delta ?? '0');
        const v2 = state.settings[key] as number;
        const atLimit = d < 0 ? v2 <= min : v2 >= max;
        b.disabled = atLimit;
      });
      // Update rounds hint and generate button
      const rounds = totalRounds(state.settings);
      const matches = rounds * state.settings.courts;
      const hint = document.querySelector<HTMLElement>('[data-setting="minutesPerMatch"]')
        ?.closest('.setting-item')?.querySelector('.setting-hint');
      if (hint) hint.textContent = `${rounds} รอบ รวม`;
      const genBtn = document.getElementById('btn-generate');
      if (genBtn) genBtn.textContent = `🗓️ สร้างตารางแข่ง (${rounds} รอบ, ~${matches} แมตช์)`;
    });
  });

  // Rank matching toggle
  document.getElementById('btn-toggle-rank-matching')?.addEventListener('click', () => {
    state.settings = { ...state.settings, useRankMatching: !(state.settings.useRankMatching ?? true) };
    storage.saveSettings(state.settings);
    renderApp();
  });

  // Generate schedule
  document.getElementById('btn-generate')?.addEventListener('click', () => {
    if (state.players.length < 4) return;
    if (state.schedule && state.schedule.rounds.length > 0) {
      state.showConfirmGenerate = true;
      renderApp();
      return;
    }
    doGenerateSchedule();
  });

  document.getElementById('btn-confirm-gen-ok')?.addEventListener('click', () => {
    state.showConfirmGenerate = false;
    doGenerateSchedule();
  });

  const closeConfirmGen = () => { state.showConfirmGenerate = false; renderApp(); };
  document.getElementById('btn-confirm-gen-cancel')?.addEventListener('click', closeConfirmGen);
  document.getElementById('confirm-generate-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirmGen();
  });

  // Session date / label inputs
  const sessionDateInput = document.getElementById('session-date') as HTMLInputElement | null;
  const sessionLabelInput = document.getElementById('session-label') as HTMLInputElement | null;
  sessionDateInput?.addEventListener('change', () => { state.sessionDate = sessionDateInput.value; });
  sessionLabelInput?.addEventListener('input', () => { state.sessionLabel = sessionLabelInput.value; });

  // Save session
  document.getElementById('btn-save-session')?.addEventListener('click', saveSession);

  // Record match result
  // Move round up/down
  document.querySelectorAll<HTMLButtonElement>('[data-move-round]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.schedule) return;
      const idx = parseInt(btn.dataset.moveRound!);
      const dir = parseInt(btn.dataset.moveDir!);
      const rounds = state.schedule.rounds;
      const target = idx + dir;
      if (target < 0 || target >= rounds.length) return;
      [rounds[idx], rounds[target]] = [rounds[target], rounds[idx]];
      storage.saveSchedule(state.schedule);
      renderApp();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-match-result]').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.matchResult!;
      const team = parseInt(btn.dataset.team!) as 1 | 2;
      state.results[matchId] = team;
      storage.saveResults(state.results);
      refreshMatchButtons(matchId);
      refreshProgressBanner();
    });
  });

  // Reset match result
  document.querySelectorAll<HTMLButtonElement>('[data-match-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const matchId = btn.dataset.matchReset!;
      delete state.results[matchId];
      storage.saveResults(state.results);
      btn.remove();
      refreshMatchButtons(matchId);
      refreshProgressBanner();
    });
  });

  // Expand/collapse session
  document.querySelectorAll<HTMLButtonElement>('[data-session-expand]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.sessionExpand!;
      state.expandedSessionId = state.expandedSessionId === id ? null : id;
      renderApp();
    });
  });

  // Delete session
  document.querySelectorAll<HTMLButtonElement>('.btn-delete-session').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('ลบเซสชันนี้?')) return;
      state.sessions = state.sessions.filter(s => s.id !== btn.dataset.sessionId);
      storage.saveSessions(state.sessions);
      renderApp();
    });
  });
}

function saveSession(): void {
  if (!state.schedule) return;
  if (isCurrentScheduleSaved()) return;

  const session: Session = {
    id: uid(),
    date: state.sessionDate || todayStr(),
    label: state.sessionLabel.trim(),
    schedule: state.schedule,
    results: { ...state.results },
    savedAt: Date.now(),
  };

  state.sessions = [session, ...state.sessions];
  storage.saveSessions(state.sessions);
  state.sessionLabel = '';
  renderApp();
}

function refreshMatchButtons(matchId: string): void {
  const result = state.results[matchId];
  const hasResult = result !== undefined;

  // Update both normal and fullscreen buttons
  document.querySelectorAll<HTMLButtonElement>(`[data-match-result="${matchId}"]`).forEach(btn => {
    const t = parseInt(btn.dataset.team!) as 1 | 2;
    const won = result === t;
    const isFs = btn.classList.contains('fs-result-btn');
    btn.className = isFs
      ? `fs-result-btn ${won ? 'fs-btn-winner' : hasResult ? 'fs-btn-loser' : ''}`
      : `result-btn ${won ? 'winner' : hasResult ? 'loser' : 'unset'}`;
    btn.textContent = won ? '🏆 ชนะ' : hasResult ? 'แพ้' : t === 1 ? '👈 ทีมซ้าย' : 'ทีมขวา 👉';
  });

  // Handle fs reset button
  const fsResultRow = document.querySelector<HTMLElement>(`.fs-result-row:has([data-match-result="${matchId}"])`);
  if (fsResultRow) {
    if (hasResult && !fsResultRow.querySelector('[data-match-reset]')) {
      const rb = document.createElement('button');
      rb.className = 'fs-reset-btn';
      rb.dataset.matchReset = matchId;
      rb.title = 'รีเซ็ต';
      rb.textContent = '↺';
      rb.addEventListener('click', () => {
        delete state.results[matchId];
        storage.saveResults(state.results);
        rb.remove();
        refreshMatchButtons(matchId);
        refreshProgressBanner();
      });
      fsResultRow.appendChild(rb);
    } else if (!hasResult) {
      fsResultRow.querySelector('[data-match-reset]')?.remove();
    }
  }

  const matchCard = document.querySelector<HTMLElement>(`[data-match-result="${matchId}"]`)?.closest('.match-card');
  if (matchCard) matchCard.classList.toggle('match-done', hasResult);

  const resultRow = document.querySelector<HTMLElement>(`[data-match-result="${matchId}"]`)?.closest('.result-row');
  if (resultRow && hasResult && !resultRow.querySelector('[data-match-reset]')) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'result-btn reset';
    resetBtn.dataset.matchReset = matchId;
    resetBtn.title = 'รีเซ็ต';
    resetBtn.textContent = '↺';
    resetBtn.addEventListener('click', () => {
      delete state.results[matchId];
      storage.saveResults(state.results);
      resetBtn.remove();
      refreshMatchButtons(matchId);
      refreshProgressBanner();
    });
    resultRow.appendChild(resetBtn);
  }
}

function refreshProgressBanner(): void {
  const done = recordedCount();
  const total = state.schedule?.rounds.reduce((s, r) => s + r.matches.length, 0) ?? 0;
  const banner = document.querySelector<HTMLElement>('.progress-banner');
  if (banner) {
    const pct = Math.round((done / total) * 100);
    banner.innerHTML = `✅ บันทึกผลแล้ว ${done}/${total} แมตช์
      <div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>`;
  } else if (done === 1) {
    renderApp();
  }
}

function addPlayer(): void {
  const name = state.newPlayerName.trim();
  if (!name) {
    const input = document.getElementById('input-name') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.style.borderColor = 'var(--danger)';
      setTimeout(() => (input.style.borderColor = ''), 1000);
    }
    return;
  }
  state.players = [...state.players, { id: uid(), name, rank: state.newPlayerRank }];
  storage.savePlayers(state.players);
  state.newPlayerName = '';
  renderApp();
  setTimeout(() => (document.getElementById('input-name') as HTMLInputElement | null)?.focus(), 50);
}

// ─── Escape HTML ──────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('connection-changed', () => renderApp());

if (state.inRoom) {
  setupRoomSubscriptions();
} else {
  _lobbyUnsubscribe = subscribeRoomList((rooms, error) => {
    state.rooms = rooms;
    state.roomsError = error ?? null;
    if (!state.inRoom) renderApp();
  });
}

applyZoom();
renderApp();
