const data = window.BUSAN_SEA_DATA;
const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
let supabase = null;
const supabaseSettings = { url: 'https://djximbcwymgcdnkllwbr.supabase.co', publishableKey: 'sb_publishable_DyW8KqpJYwzxGqhkVxCw7Q_vLv_ukV8' };

let screen = 'home';
let chosenPlace = data.places[0];
let chosenMission = null;
let recommendations = data.missions.slice(0, 6);
let missionDestination = 'all';
let missionPlaceQuery = '';
let dailyMissionDate = '';
let dailyMissionIds = [];
let leisureFilter = { people: '2', age: '청소년' };
let userPosition = null;
let mapFocus = null;
let currentUser = null;
let communityPosts = [];
let bookingActivity = null;
let toastTimer;
let seaMap = null;
let nearbyLoadToken = 0;
let missionMemories = [];
let savedLeisureIds = [];
let selectedMood = '😄';
let selectedWeather = '🌤️';
let localPhotoClassifier = null;
const APP_RELEASE = 15;
const APP_VERSION = `1.${String(APP_RELEASE).padStart(2, '0')}`;

const won = (number) => number === 0 ? '무료' : `${number.toLocaleString()}원`;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const usernameFromUser = (user) => user?.user_metadata?.username || user?.email?.split('@')[0] || '바다 친구';
const isDemoUser = () => Boolean(currentUser?.isDemo);
const formatDate = (value) => new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(new Date(value));
const todayInKorea = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const date = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
};
const resetDailyMissionsIfNeeded = () => {
  const today = todayInKorea();
  if (dailyMissionDate === today) return false;
  dailyMissionDate = today;
  dailyMissionIds = [];
  return true;
};
const completedToday = (missionId) => { resetDailyMissionsIfNeeded(); return dailyMissionIds.includes(missionId); };
const progressKey = () => currentUser ? `cashbada-progress-${currentUser.id}` : null;
const leisureSaveKey = () => currentUser ? `cashbada-leisure-saves-${currentUser.id}` : null;
const loadProgress = () => {
  const key = progressKey();
  if (!key) return;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Array.isArray(saved.completedMissionIds) && Number.isFinite(saved.points)) {
      data.currentUser.points = saved.points;
      data.currentUser.completedMissionIds = saved.completedMissionIds;
      dailyMissionDate = saved.dailyMissionDate || todayInKorea();
      dailyMissionIds = Array.isArray(saved.dailyMissionIds) ? saved.dailyMissionIds : [];
      resetDailyMissionsIfNeeded();
    } else {
      data.currentUser.points = 0;
      data.currentUser.completedMissionIds = [];
      dailyMissionDate = todayInKorea();
      dailyMissionIds = [];
    }
  } catch { data.currentUser.points = 0; data.currentUser.completedMissionIds = []; dailyMissionDate = todayInKorea(); dailyMissionIds = []; }
};
const saveProgress = () => {
  const key = progressKey();
  resetDailyMissionsIfNeeded();
  if (key) localStorage.setItem(key, JSON.stringify({ points: data.currentUser.points, completedMissionIds: data.currentUser.completedMissionIds, dailyMissionDate, dailyMissionIds }));
  if (currentUser && !isDemoUser()) void syncProgressToCloud();
};
const loadSavedLeisure = () => {
  const key = leisureSaveKey();
  if (!key) return savedLeisureIds = [];
  try { savedLeisureIds = JSON.parse(localStorage.getItem(key) || '[]'); } catch { savedLeisureIds = []; }
};
const saveSavedLeisure = () => {
  const key = leisureSaveKey();
  if (key) localStorage.setItem(key, JSON.stringify(savedLeisureIds));
  if (currentUser && !isDemoUser()) void syncProgressToCloud();
};
const showToast = (message) => {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
};

async function ensureSupabase() {
  // 화면을 열 때 로그인 서버에 접속하지 않고, 로그인 버튼을 누른 순간에만 요청합니다.
  return true;
}

function missionPhotoLabel(mission) {
  const title = mission.title;
  if (title.includes('쓰레기') || title.includes('분리수거')) return 'a person picking up litter or recycling at a beach';
  if (title.includes('다회용') || title.includes('비닐 없이') || title.includes('물 아껴')) return 'an eco-friendly reusable item near the sea or a market';
  if (title.includes('수산물') || title.includes('멸치') || title.includes('간식')) return 'Korean seafood or local food at a market';
  if (title.includes('엽서') || title.includes('책')) return 'a postcard or a book related to the sea';
  if (title.includes('케이블카')) return 'a cable car with an ocean view';
  if (title.includes('광안대교') || title.includes('야경')) return 'a bridge by the sea or a night harbor view';
  if (title.includes('등대')) return 'a lighthouse by the sea';
  if (title.includes('생물') || title.includes('조개')) return 'a sea creature, seashell, or coastal nature';
  if (title.includes('안전') || title.includes('표지판') || title.includes('예절') || title.includes('준비물')) return 'a beach safety sign, safety guide, or water sports equipment';
  if (title.includes('노을')) return 'a sunset at a beach';
  if (title.includes('산책') || title.includes('해안길')) return 'a person walking on a coastal trail';
  return 'a photograph of the ocean, beach, or a marine tourism activity';
}

async function verifyPhotoOnDevice(photo, mission) {
  try {
    showToast('AI가 이 미션 기준으로 사진을 확인하는 중이에요…');
    if (!localPhotoClassifier) {
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
      localPhotoClassifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32');
    }
    const expected = missionPhotoLabel(mission);
    const results = await localPhotoClassifier(photo, [expected, 'an unrelated photo that does not show the mission activity']);
    const matched = results[0]?.label === expected && results[0]?.score >= 0.55;
    return matched
      ? { approved: true, message: 'AI가 이 미션 활동과 관련된 사진으로 확인했어요.' }
      : { approved: false, message: `AI가 “${mission.title}” 미션과 사진의 관련성을 확인하기 어려워요. 미션 활동이나 장소가 더 잘 보이게 다시 찍어 주세요.` };
  } catch (error) {
    console.warn('사진 AI 오류:', error);
    return { approved: true, message: 'AI 모델을 불러오지 못해 사진 형식만 확인하고 진행했어요.' };
  }
}

const sessionStorageKey = 'cashbada-login-session';
const demoReviewsKey = 'cashbada-demo-community-posts';
const getStoredSession = () => {
  try { return JSON.parse(localStorage.getItem(sessionStorageKey) || 'null'); } catch { return null; }
};
const saveSession = (session) => localStorage.setItem(sessionStorageKey, JSON.stringify(session));
const clearSession = () => localStorage.removeItem(sessionStorageKey);
const getDemoReviews = () => {
  try { return JSON.parse(localStorage.getItem(demoReviewsKey) || '[]'); } catch { return []; }
};
const saveDemoReviews = (posts) => localStorage.setItem(demoReviewsKey, JSON.stringify(posts));

async function startDemo() {
  let publicDemo = false;
  try {
    const session = await supabaseRequest('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ data: { username: '데모 여행가' } }) });
    if (!session?.access_token || !session?.user) throw new Error('데모 계정을 만들지 못했어요.');
    currentUser = { ...session.user, isDemo: true };
    saveSession({ ...session, user: currentUser, isDemo: true });
    publicDemo = true;
  } catch (error) {
    console.warn('공개 데모 계정 연결 오류:', error);
    currentUser = { id: 'demo-local-user', isDemo: true, user_metadata: { username: '데모 여행가' } };
    saveSession({ user: currentUser, isDemo: true });
  }
  loadProgress();
  loadSavedLeisure();
  await loadMissionMemories();
  document.querySelector('.modal')?.remove();
  screen = 'profile';
  render();
  showToast(publicDemo ? '공개 데모를 시작했어요. 데모 후기도 커뮤니티에 남아요!' : '데모 체험을 시작했어요. 현재 후기는 이 브라우저에만 저장돼요.');
}
async function supabaseRequest(path, options = {}) {
  const session = getStoredSession();
  const headers = {
    apikey: supabaseSettings.publishableKey,
    ...(options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${supabaseSettings.url}${path}`, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.msg || body?.message || '서버 연결에 실패했어요.');
  return body;
}

const memoryForCloud = (memory) => ({
  missionId: memory.missionId, title: memory.title, date: memory.date,
  mood: memory.mood, weather: memory.weather, note: memory.note || '',
  createdAt: memory.createdAt, hasPhoto: Boolean(memory.photo || memory.photoPath || memory.photos?.length || memory.photoPaths?.length),
  photoPath: memory.photoPath || memory.photoPaths?.[0] || null, photoPaths: memory.photoPaths || []
});

async function uploadMissionPhoto(photo, missionId, index = 0) {
  const extension = (photo.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const photoPath = `${currentUser.id}/${missionId}-${Date.now()}-${index + 1}.${extension}`;
  await supabaseRequest(`/storage/v1/object/mission-photos/${photoPath}`, {
    method: 'POST', body: photo, headers: { 'Content-Type': photo.type || 'image/jpeg', 'x-upsert': 'true' }
  });
  return photoPath;
}

async function loadMissionPhotos(memory) {
  const photoPaths = memory.photoPaths?.length ? memory.photoPaths : memory.photoPath ? [memory.photoPath] : [];
  if (memory.photoUrls?.length || !photoPaths.length) return;
  const signedPhotos = await Promise.all(photoPaths.map(async (photoPath) => {
    const signed = await supabaseRequest(`/storage/v1/object/sign/mission-photos/${photoPath}`, {
      method: 'POST', body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!signed?.signedURL) throw new Error('사진 주소를 만들지 못했어요.');
    return `${supabaseSettings.url}/storage/v1${signed.signedURL}`;
  }));
  memory.photoUrls = signedPhotos;
  memory.photoUrl = signedPhotos[0] || null;
}

async function openMissionMemory(memory) {
  try { await loadMissionPhotos(memory); } catch (error) { console.warn('사진 불러오기 오류:', error); }
  app.insertAdjacentHTML('beforeend', missionMemoryModal(memory));
}

async function migrateLocalPhotosToCloud() {
  if (!currentUser || isDemoUser()) return;
  let migrated = false;
  for (const memory of missionMemories) {
    const photos = memory.photos?.length ? memory.photos : memory.photo ? [memory.photo] : [];
    if (!photos.length || memory.photoPaths?.length || memory.photoPath) continue;
    try {
      memory.photoPaths = await Promise.all(photos.map((photo, index) => uploadMissionPhoto(photo, memory.missionId, index)));
      memory.photoPath = memory.photoPaths[0];
      migrated = true;
    } catch (error) { console.warn('기존 사진 이전 오류:', error); }
  }
  if (migrated) await syncProgressToCloud();
}

async function syncProgressToCloud() {
  if (!currentUser || isDemoUser()) return;
  try {
    await supabaseRequest('/rest/v1/user_progress', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: currentUser.id,
        points: data.currentUser.points,
        completed_mission_ids: data.currentUser.completedMissionIds,
        saved_leisure_ids: savedLeisureIds,
        mission_memories: missionMemories.map(memoryForCloud),
        updated_at: new Date().toISOString()
      })
    });
  } catch (error) { console.warn('기록 동기화 오류:', error); }
}

async function loadCloudProgress() {
  if (!currentUser || isDemoUser()) return;
  try {
    const rows = await supabaseRequest(`/rest/v1/user_progress?user_id=eq.${encodeURIComponent(currentUser.id)}&select=points,completed_mission_ids,mission_memories,saved_leisure_ids`);
    const saved = rows?.[0];
    if (!saved) return void syncProgressToCloud();
    data.currentUser.points = Number.isFinite(saved.points) ? saved.points : 0;
    data.currentUser.completedMissionIds = Array.isArray(saved.completed_mission_ids) ? saved.completed_mission_ids : [];
    savedLeisureIds = Array.isArray(saved.saved_leisure_ids) ? saved.saved_leisure_ids : [];
    saveSavedLeisure();
    const localByMission = new Map(missionMemories.map((memory) => [memory.missionId, memory]));
    const remoteMemories = Array.isArray(saved.mission_memories) ? saved.mission_memories : [];
    const remoteIds = new Set(remoteMemories.map((memory) => memory.missionId));
    missionMemories = [...remoteMemories.map((memory) => ({ ...memory, ...(localByMission.get(memory.missionId) || {}) })), ...missionMemories.filter((memory) => !remoteIds.has(memory.missionId))];
    saveProgress();
  } catch (error) { console.warn('기록 불러오기 오류:', error); }
}

async function signOut() {
  // 서버 연결에 실패해도 이 기기에 남은 로그인 정보는 반드시 지웁니다.
  if (!isDemoUser()) {
    try { await supabaseRequest('/auth/v1/logout', { method: 'POST' }); } catch (error) { console.warn('서버 로그아웃 처리:', error); }
  }
  clearSession();
  currentUser = null;
  data.currentUser.points = 0;
  data.currentUser.completedMissionIds = [];
  dailyMissionDate = todayInKorea();
  dailyMissionIds = [];
  screen = 'home';
  render();
  showToast('로그아웃했어요.');
}

async function openAuthModal() {
  showToast('로그인 기능을 준비하고 있어요.');
  if (await ensureSupabase()) {
    if (currentUser) { screen = 'profile'; render(); showToast('이미 로그인되어 있어요.'); return; }
    app.insertAdjacentHTML('beforeend', authModal());
  }
}

function openMemoryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cashbada-memories', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('memories', { keyPath: 'missionId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadMissionMemories() {
  try {
    const database = await openMemoryDatabase();
    const transaction = database.transaction('memories', 'readonly');
    const request = transaction.objectStore('memories').getAll();
    missionMemories = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  } catch { missionMemories = []; }
}

async function saveMissionMemory(memory) {
  const database = await openMemoryDatabase();
  const transaction = database.transaction('memories', 'readwrite');
  transaction.objectStore('memories').put(memory);
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  missionMemories = missionMemories.filter((item) => item.missionId !== memory.missionId);
  missionMemories.unshift(memory);
  if (currentUser && !isDemoUser()) void syncProgressToCloud();
}

window.addEventListener('error', (event) => {
  console.error(event.error || event.message);
  if (!app.innerHTML) {
    app.innerHTML = '<main class="page"><section class="empty"><h2>캐시 바다를 여는 중 문제가 생겼어요.</h2><p>인터넷 연결을 확인한 뒤 F5로 다시 열어 주세요.</p></section></main>';
  }
});
const distanceKm = (latitude, longitude) => {
  if (!userPosition) return null;
  const radius = 6371;
  const radians = (value) => value * Math.PI / 180;
  const lat = radians(latitude - userPosition.latitude);
  const lng = radians(longitude - userPosition.longitude);
  const value = Math.sin(lat / 2) ** 2 + Math.cos(radians(userPosition.latitude)) * Math.cos(radians(latitude)) * Math.sin(lng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

function header() {
  const account = currentUser
    ? `<button class="points" data-go="profile">👤 ${escapeHtml(usernameFromUser(currentUser))}</button>`
    : '<button class="points" data-action="auth-form">로그인</button>';
  return `<header class="header"><button class="brand" data-go="home" aria-label="첫 화면으로"><span class="logo">🌊</span><span><b>캐시 바다 <em class="app-version">v${APP_VERSION}</em></b><small>Cash Bada</small></span></button><div class="top-actions">${account}<button class="points" data-go="points">🐚 ${data.currentUser.points.toLocaleString()}P</button></div></header>`;
}

function navigation() {
  const icon = (name) => ({
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    mission: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m16 8 5-5"/></svg>',
    leisure: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c3 0 3-3 6-3s3 3 6 3 3-3 6-3M3 19c3 0 3-3 6-3s3 3 6 3 3-3 6-3M12 4v7m0-7 3 3m-3-3L9 7"/></svg>',
    community: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8m-8 3h5"/></svg>',
    profile: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>'
  }[name]);
  const tabs = [['home', 'home', '홈'], ['missions', 'mission', '미션'], ['leisure', 'leisure', '레저 추천'], ['community', 'community', '커뮤니티'], ['profile', 'profile', '마이']];
  return `<nav class="bottom-nav" aria-label="주요 메뉴">${tabs.map(([id, iconName, label]) => `<button class="nav ${screen === id ? 'active' : ''}" data-go="${id}"><span class="ni nav-icon">${icon(iconName)}</span><span>${label}</span></button>`).join('')}</nav>`;
}

function pageTitle(title, subtitle, back = 'home') {
  return `<div class="page-head"><button class="back" data-go="${back}" aria-label="이전 화면">←</button><div><h1>${title}</h1><p>${subtitle}</p></div></div>`;
}

function placeCard() {
  const p = chosenPlace;
  return `<article class="place-sheet"><div class="top"><span class="place-emoji">${p.icon}</span><div><h3>${p.name}</h3><p class="muted">${p.category} · ${p.distance}km · ⭐ ${p.rating} (${p.reviews})</p></div></div><p class="muted" style="margin-top:10px">${p.note}</p><div class="card-actions"><button class="secondary" data-action="save">저장</button><button class="start" data-action="place-missions">관련 미션 보기</button></div></article>`;
}

function home() {
  resetDailyMissionsIfNeeded();
  const complete = dailyMissionIds.length;
  return `<main class="page"><section class="hero"><span class="eyebrow">TODAY IN BUSAN</span><h1>바다를 즐기고<br><span>부산을 더 푸르게</span></h1><p>내 주변의 해양 미션을 발견하고<br>작은 행동으로 바다를 지켜보세요.</p><button class="primary" data-go="missions">오늘의 미션 6개 받기 <span>→</span></button></section><section class="status"><div><small>오늘의 미션</small><strong>${complete} / 6</strong></div><div class="progress"><i style="width:${Math.min(100, complete / 6 * 100)}%"></i></div><button class="link-btn" data-go="missions">진행 보기 →</button></section><section class="section-title"><div><span class="eyebrow">NEARBY SEA MAP</span><h2>${userPosition ? '내 주변 바다 지도' : '부산 바다 지도'}</h2></div><button class="circle-btn" data-action="location" aria-label="현재 위치 확인">⌖</button></section><button class="recommend" data-action="location" style="margin:0 0 14px">${userPosition ? '현재 위치로 지도 다시 맞추기' : '위치 허용하고 내 주변 바다 지도 보기'}</button><p class="muted" style="margin:-7px 0 14px">지도는 손가락/마우스로 이동하고 +, − 버튼으로 확대·축소할 수 있어요. 위치는 저장하지 않아요.</p><div class="search"><input id="map-search" aria-label="지도 장소 검색" placeholder="해변, 바다 레저, 지역을 검색하세요"><button data-action="map-search">찾기</button></div><div class="map-legend"><span>🏖 해변</span><span>🐟 해산물 음식점</span><span>☕ 바다 카페</span><span>🏄 레저·대여</span><span>🧰 용품점</span></div><section id="nearby-map" class="map" aria-label="현재 위치 기반 바다 지도"><span class="map-caption">${userPosition ? '내 위치 기준 주변 해양 정보' : '위치 허용 전: 부산 바다 기본 지도'}</span></section></main>`;
}

function missionCard(mission) {
  const isDone = completedToday(mission.id);
  return `<article class="mission-card"><div class="card-top"><span class="tag">${mission.category}</span><span class="tag eco">🌿 환경 기여 ${mission.ecoScore}/5</span></div><h3>${mission.title}</h3><p class="muted">📍 ${mission.location} · ${mission.distance}km</p><div class="facts"><span>⏱ ${mission.minutes}분</span><span>💳 ${won(mission.cost)}</span><span>🐚 ${mission.points}P</span><span>${mission.difficulty}</span></div><div class="card-actions"><button class="start" data-action="mission" data-id="${mission.id}">${isDone ? '완료 확인' : '시작하기'}</button></div></article>`;
}

function missions() {
  resetDailyMissionsIfNeeded();
  const destinationOptions = [{ id: 'all', name: '대표 해안 권역 선택' }, { id: 'current', name: '현재 위치 근처' }, ...missionAreas].map((area) => `<option value="${area.id}" ${missionDestination === area.id ? 'selected' : ''}>${area.name}</option>`).join('');
  return `<main class="page">${pageTitle('오늘의 미션', '목적지나 현재 위치 주변의 바다 미션만 추천해요.')}<section class="filter-box"><div class="notice" style="margin:0 0 14px">오늘 참여 ${dailyMissionIds.length} / 6개 · 매일 자정에 다시 0개로 시작해요.</div><div class="form-grid"><label class="field full">미션 목적지<select id="mission-destination">${destinationOptions}</select></label><label class="field full">직접 입력<input id="mission-place-query" value="${escapeHtml(missionPlaceQuery)}" placeholder="예: 자갈치시장, 해운대, 송도"></label><label class="field">예산<select id="budget"><option value="0">0원</option><option value="20000" selected>2만원 이하</option><option value="50000">5만원 이하</option></select></label><label class="field">관심 분야<select id="interest"><option value="전체">전체</option><option value="사진">사진</option><option value="환경">환경</option><option value="먹거리">먹거리</option><option value="레저">레저</option></select></label></div><p class="muted" style="margin:12px 0 0">직접 입력이 있으면 그 장소를 우선 적용해요. 현재 위치는 권한 허용 뒤에 사용할 수 있어요.</p><button class="recommend" data-action="recommend">이 주변 미션 추천받기</button></section><div>${recommendations.map(missionCard).join('') || '<div class="empty">이 주변에는 조건에 맞는 미션이 없어요. 예산 조건을 넓히거나 다른 목적지를 골라 보세요.</div>'}</div></main>`;
}

function missionDetail() {
  const m = chosenMission;
  const done = completedToday(m.id);
  return `<main class="page">${pageTitle('미션 진행', '바다를 즐기며 환경도 지켜요.', 'missions')}<section class="mission-hero"><span class="tag">${m.category}</span><p class="big">${m.title}</p><div class="facts"><span>📍 ${m.location}</span><span>⏱ ${m.minutes}분</span><span>🐚 ${m.points}P</span></div><p class="muted">인증 방법: ${m.verification}</p></section><div class="notice">🛟 ${m.safety} 위험하면 보호자와 함께해 주세요.</div>${done ? '<div class="success" style="margin-top:16px">이미 완료한 미션입니다.</div>' : `<section class="verification"><b>미션 인증하기</b><p class="muted" style="margin-top:5px">프로토타입에서는 제출 즉시 완료 처리됩니다.</p><button class="recommend" data-action="complete" data-id="${m.id}">인증 제출하고 ${m.points}P 받기</button></section>`}</main>`;
}

function missionDetail() {
  const m = chosenMission;
  const done = completedToday(m.id);
  const memory = missionMemories.find((item) => item.missionId === m.id);
  const today = new Date().toISOString().slice(0, 10);
  const moodOptions = [
    ['😄', '완전 방긋'], ['🙂', '조금 방긋'], ['😢', '슬픔'],
    ['😫', '피곤'], ['😍', '감동'], ['🔥', '열정']
  ];
  const weatherOptions = ['☀️', '🌤️', '☁️', '🌦️', '🌬️'];
  return `<main class="page">${pageTitle('미션 인증', '사진과 나만의 기록을 남겨 보세요.', 'missions')}<section class="mission-hero"><span class="tag">${m.category}</span><p class="big">${m.title}</p><div class="facts"><span>📍 ${m.location}</span><span>⏱ ${m.minutes}분</span><span>🐚 ${m.points}P</span></div><p class="muted">인증 방법: ${m.verification}</p></section><div class="notice">🛟 ${m.safety}</div>${done ? `<section class="success" style="margin-top:16px"><b>인증 완료한 미션이에요.</b><br>${memory ? `<button class="link-btn" data-action="memory-detail" data-id="${m.id}" style="margin-top:10px">내 사진과 감상평 다시 보기 →</button>` : ''}</section>` : `<section class="verification"><b>미션 사진 인증</b><p class="muted" style="margin-top:5px">사진은 1장 이상 필수이며, 최대 5장까지 추가할 수 있어요. 사진 사용·저장 동의에 체크하지 않으면 미션에 참여할 수 없어요.</p><label class="field" style="margin-top:12px">인증 사진 (1~5장)<input id="mission-photo" type="file" accept="image/*" multiple></label><label class="consent" style="margin-top:12px"><input id="photo-consent" type="checkbox"> <span>사진을 이 기기 브라우저에 저장하고, AI가 내 기기 안에서 바다 관련 사진인지 확인하는 것에 동의합니다. 동의하지 않으면 미션에 참여할 수 없습니다.</span></label><div class="notice" style="margin-top:12px">🤖 AI는 첫 번째 사진이 미션과 관련 있는지 확인합니다. 처음 한 번은 모델을 받아와 시간이 조금 걸릴 수 있어요.</div><label class="field" style="margin-top:14px">기록 날짜<input id="memory-date" type="date" value="${today}"></label><div class="field" style="margin-top:14px">오늘의 기분<div class="chips">${moodOptions.map(([emoji, label]) => `<button type="button" class="chip ${emoji === selectedMood ? 'active' : ''}" data-action="mood" data-value="${emoji}" title="${label}" aria-label="${label}">${emoji}</button>`).join('')}</div></div><div class="field" style="margin-top:8px">오늘의 날씨<div class="chips">${weatherOptions.map((emoji) => `<button type="button" class="chip ${emoji === selectedWeather ? 'active' : ''}" data-action="memory-weather" data-value="${emoji}">${emoji}</button>`).join('')}</div></div><label class="field" style="margin-top:8px">오늘의 바다 일기 (선택)<textarea id="memory-note" maxlength="500" placeholder="오늘 바다에서 느낀 점, 기억하고 싶은 순간을 적어 보세요."></textarea></label><button class="recommend" data-action="complete" data-id="${m.id}">사진으로 인증하고 ${m.points}P 받기</button></section>`}</main>`;
}

function missionMemoryModal(memory) {
  const sources = memory.photoUrls?.length ? memory.photoUrls : memory.photoUrl ? [memory.photoUrl] : memory.photos?.length ? memory.photos.map((photo) => URL.createObjectURL(photo)) : memory.photo ? [URL.createObjectURL(memory.photo)] : [];
  const photos = sources.length ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:16px 0">${sources.map((source, index) => `<img src="${source}" alt="미션 인증 사진 ${index + 1}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:14px">`).join('')}</div>` : '<p class="muted" style="margin:16px 0">이 인증 사진은 아직 계정 보관함에 연결되지 않았어요.</p>';
  return `<div class="modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close" aria-label="닫기">×</button><h2>${escapeHtml(memory.title)}</h2><p class="muted">${memory.date} · ${memory.mood} 기분 · ${memory.weather} 날씨</p>${photos}<div class="notice"><b>나의 바다 일기</b><br>${escapeHtml(memory.note || '감상평을 남기지 않았어요.').replace(/\n/g, '<br>')}</div></section></div>`;
}

async function submitMissionVerification(mission) {
  resetDailyMissionsIfNeeded();
  if (dailyMissionIds.length >= 6) return showToast('오늘은 미션 6개를 모두 참여했어요. 자정 이후에 다시 참여할 수 있어요.');
  if (completedToday(mission.id)) return showToast('이 미션은 오늘 이미 인증했어요. 다른 미션을 골라 주세요.');
  const photos = Array.from(document.querySelector('#mission-photo')?.files || []);
  const consent = document.querySelector('#photo-consent')?.checked;
  if (!consent) return showToast('사진 사용·저장 동의에 체크해야 미션에 참여할 수 있어요.');
  if (!photos.length || photos.some((photo) => !photo.type.startsWith('image/'))) return showToast('미션 인증 사진을 1장 이상 선택해 주세요.');
  if (photos.length > 5) return showToast('인증 사진은 최대 5장까지 올릴 수 있어요.');
  const aiResult = await verifyPhotoOnDevice(photos[0], mission);
  if (!aiResult.approved) return showToast(aiResult.message);
  showToast(aiResult.message);
  let photoPaths = [];
  if (!isDemoUser()) {
    try { photoPaths = await Promise.all(photos.map((photo, index) => uploadMissionPhoto(photo, mission.id, index))); } catch { return showToast('사진을 계정 보관함에 저장하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  }
  const memory = { missionId: mission.id, title: mission.title, photo: photos[0], photos, photoPath: photoPaths[0], photoPaths, date: document.querySelector('#memory-date').value, mood: selectedMood, weather: selectedWeather, note: document.querySelector('#memory-note').value.trim(), createdAt: new Date().toISOString() };
  try { await saveMissionMemory(memory); } catch { return showToast('사진 저장 공간이 부족해 인증하지 못했어요.'); }
  dailyMissionIds.push(mission.id);
  if (!data.currentUser.completedMissionIds.includes(mission.id)) data.currentUser.completedMissionIds.push(mission.id);
  data.currentUser.points += mission.points;
  saveProgress();
  screen = 'profile';
  render();
  showToast('사진을 확인하고 미션 인증을 완료했어요!');
}

function leisureGuide(item) {
  const people = Number(leisureFilter.people);
  const age = leisureFilter.age;
  const groupTip = people === 1 ? '혼자 참여한다면 강습 시작 15분 전 도착해 안전 안내를 들어 보세요.' : people >= 4 ? '여러 명이면 역할을 나누고 서로의 구명조끼 착용을 확인해 주세요.' : `${people}명이 함께라면 사진 촬영 시간과 휴식 시간을 미리 정하면 좋아요.`;
  const ageTip = age === '가족' ? '가족 추천: 보호자 동행과 어린이용 구명조끼 여부를 먼저 확인하세요.' : age === '청소년' ? '청소년 추천: 체험 가능 나이와 보호자 동행 규정을 현장에 확인하세요.' : age === '성인' ? '성인 추천: 초보자는 기본 강습이 포함된 시간대를 골라 보세요.' : '모든 연령 추천: 이동이 편한 신발과 물을 준비하세요.';
  const packing = item.type.includes('수상') ? '준비물: 물에 젖어도 되는 옷, 여벌 옷, 수건, 자외선 차단제' : item.type.includes('해양') ? '준비물: 편한 신발, 물, 얇은 겉옷' : '준비물: 모자, 물, 자외선 차단제';
  return `<div class="reason"><b>왜 추천하나요?</b> ${item.reason}<br><b>참여 팁:</b> ${groupTip}<br><b>나이대 팁:</b> ${ageTip}<br><b>${packing}</b><br><small>체험 비용은 예시이며, 실제 예약 전 운영처 정보를 확인해 주세요.</small></div>`;
}

function leisure() {
  const ageMatches = (item) => leisureFilter.age === '모든 연령' || item.age.includes('모든') || (leisureFilter.age === '청소년' && (item.age.includes('초등') || item.age.includes('청소년'))) || (leisureFilter.age === '가족' && (item.age.includes('초등') || item.age.includes('가족'))) || leisureFilter.age === '성인';
  const filtered = data.leisureActivities.filter(ageMatches).map((item) => ({ ...item, distance: distanceKm(item.latitude, item.longitude) })).sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  const cards = filtered.map((item) => {
    const saved = savedLeisureIds.includes(item.id);
  return `<article class="leisure-card"><div class="card-top"><span class="tag">${item.type}</span><span class="stars">★★★★★</span></div><h3>${item.emoji} ${item.title}</h3><p class="muted">📍 ${item.place} · ${item.age} · ${leisureFilter.people}명 참여</p><div class="facts"><span>⏱ ${item.minutes}분</span><span>💳 ${won(item.cost)} (예시)</span>${item.distance !== null ? `<span>📍 약 ${item.distance.toFixed(1)}km</span>` : ''}</div>${leisureGuide(item)}<div class="card-actions"><button class="save ${saved ? 'saved-leisure' : ''}" data-action="like-leisure" data-id="${item.id}" aria-label="${saved ? '저장 취소' : '레저 저장'}" title="${saved ? '저장 취소' : '레저 저장'}">${saved ? '🌊' : '💧'}</button><button class="secondary" data-action="map" data-id="${item.id}">지도에서 보기</button><button class="start" data-action="booking" data-id="${item.id}">예약 체험하기</button></div></article>`;
  }).join('') || '<div class="empty">조건에 맞는 체험이 없어요.</div>';
  return `<main class="page">${pageTitle('레저 추천', '인원과 나이대에 맞는 부산 바다 체험이에요.')}<div class="leisure-banner" id="weather-status">🌤️ 부산의 실시간 날씨와 파도를 불러오는 중이에요.</div><section class="filter-box"><div class="form-grid"><label class="field">참여 인원<select id="leisure-people">${[1,2,3,4].map((n) => `<option value="${n}" ${leisureFilter.people === String(n) ? 'selected' : ''}>${n === 4 ? '4명 이상' : `${n}명`}</option>`).join('')}</select></label><label class="field">나이대<select id="leisure-age">${['청소년', '성인', '가족', '모든 연령'].map((age) => `<option ${leisureFilter.age === age ? 'selected' : ''}>${age}</option>`).join('')}</select></label></div><button class="recommend" data-action="apply-leisure-filter">이 조건으로 추천받기</button></section><div>${cards}</div></main>`;
}

function community() {
  const posts = communityPosts.length ? communityPosts.map((post) => `<article class="review-card"><div class="review-meta"><span>${escapeHtml(post.author)} · <span class="tag">${escapeHtml(post.activity)}</span></span><span>${formatDate(post.created_at)}</span></div><h3>${escapeHtml(post.title)}</h3><div class="stars">${'★'.repeat(post.rating)}${'☆'.repeat(5 - post.rating)}</div><p>${escapeHtml(post.body)}</p></article>`).join('') : '<div class="empty">아직 등록된 후기가 없어요.<br>부산 바다의 첫 이야기를 남겨 주세요!</div>';
  return `<main class="page">${pageTitle('바다 커뮤니티', '누구나 후기를 보고, 로그인하면 남길 수 있어요.')}<p class="muted" style="margin-bottom:12px">${currentUser ? `${escapeHtml(usernameFromUser(currentUser))}님으로 로그인 중` : '후기 작성은 로그인 후 가능해요.'}</p><button class="recommend" data-action="review-form" style="margin-bottom:16px">+ 후기 작성하기</button>${posts}</main>`;
}

function profile() {
  if (!currentUser) return `<main class="page">${pageTitle('마이 페이지', '가입한 아이디로 로그인하면 내 정보를 이어서 사용할 수 있어요.')}<section class="profile-hero"><div class="avatar">🌊</div><h2>로그인이 필요해요</h2><p>아이디와 비밀번호로 간단히 가입할 수 있습니다.</p><button class="recommend" data-action="auth-form">회원가입 또는 로그인</button></section></main>`;
  return `<main class="page"><section class="profile-hero"><div class="avatar">🌊</div><h2>${escapeHtml(usernameFromUser(currentUser))}</h2><p>부산 바다를 지키는 오늘의 여행가</p><div class="profile-points">${data.currentUser.points.toLocaleString()} P</div></section><section class="section-title"><h2>미션 인증 내역</h2></section>${data.currentUser.completedMissionIds.map((id) => { const m = data.missions.find((item) => item.id === id); return m ? `<article class="point-card"><b>${m.title}</b><strong style="display:block;color:#13835c;margin-top:9px">+ ${m.points}P</strong></article>` : ''; }).join('') || '<div class="empty">아직 완료한 미션이 없어요.</div>'}<div class="menu-list"><button class="menu-row" data-action="signout">로그아웃 <span>→</span></button></div></main>`;
}

function profile() {
  if (!currentUser) return `<main class="page">${pageTitle('마이 페이지', '로그인하면 내 미션과 추억을 이어서 볼 수 있어요.')}<section class="profile-hero"><div class="avatar">🌊</div><h2>로그인이 필요해요</h2><p>아이디와 비밀번호로 간단히 가입할 수 있습니다.</p><button class="recommend" data-action="auth-form">회원가입 또는 로그인</button></section></main>`;
  const completed = data.currentUser.completedMissionIds.map((id) => data.missions.find((item) => item.id === id)).filter(Boolean);
  const records = completed.map((mission) => {
    const memory = missionMemories.find((item) => item.missionId === mission.id);
    return `<article class="point-card ${memory ? 'memory-card' : ''}" ${memory ? `data-action="memory-detail" data-id="${mission.id}"` : ''}><b>${mission.title}</b><p class="muted" style="margin-top:5px">${memory ? `${memory.date} · ${memory.mood} ${memory.weather} · 사진과 일기가 있어요` : '미션 인증 완료'}</p><strong style="display:block;color:#13835c;margin-top:9px">+ ${mission.points}P</strong>${memory ? '<small style="display:block;margin-top:9px;color:#08789a">눌러서 추억 다시 보기 →</small>' : ''}</article>`;
  }).join('') || '<div class="empty">아직 완료한 미션이 없어요.</div>';
  const savedLeisure = savedLeisureIds.map((id) => data.leisureActivities.find((item) => item.id === id)).filter(Boolean);
  const savedCards = savedLeisure.length ? savedLeisure.map((item) => `<article class="point-card"><b>${item.emoji} ${escapeHtml(item.title)}</b><p class="muted" style="margin-top:5px">📍 ${escapeHtml(item.place)} · ${item.minutes}분</p><button class="link-btn" data-go="leisure" style="margin-top:8px">레저 추천에서 보기 →</button></article>`).join('') : '<div class="empty">아직 좋아요한 레저가 없어요.</div>';
  return `<main class="page"><section class="profile-hero"><div class="avatar">🌊</div><h2>${escapeHtml(usernameFromUser(currentUser))}</h2><p>${isDemoUser() ? '데모 체험 중 · 기록은 이 브라우저에만 저장돼요' : '부산 바다를 지키는 오늘의 여행가'}</p><div class="profile-points">${data.currentUser.points.toLocaleString()} P</div></section><section class="section-title"><div><span class="eyebrow">MY SEA MEMORY</span><h2>미션 인증 내역</h2></div></section>${records}<section class="section-title" style="margin-top:24px"><div><span class="eyebrow">SAVED LEISURE</span><h2>저장한 레저</h2></div></section>${savedCards}<div class="menu-list" style="margin-top:18px"><button class="menu-row" data-action="signout">로그아웃 <span>→</span></button></div></main>`;
}

function points() { return `<main class="page">${pageTitle('포인트 내역', '미션 완료 때 포인트가 쌓여요.', 'profile')}<section class="profile-hero"><p>현재 보유 포인트</p><div class="profile-points">${data.currentUser.points.toLocaleString()} P</div></section></main>`; }

function authModal() {
  return `<div class="modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close" aria-label="닫기">×</button><h2>캐시 바다 계정</h2><p class="muted">이메일 없이 아이디와 비밀번호만 사용해요.</p><label class="field" style="margin-top:12px">아이디<input id="auth-username" autocomplete="username" placeholder="영문, 숫자, . _ - (3~20자)"></label><label class="field" style="margin-top:12px">비밀번호<input id="auth-password" type="password" autocomplete="current-password" placeholder="6자 이상"></label><label class="consent"><input id="auth-consent" type="checkbox"> <span>서비스 이용을 위한 아이디·비밀번호 처리와 내 미션 기록 저장에 동의합니다.</span></label><div class="card-actions"><button class="secondary" data-action="signin">로그인</button><button class="start" data-action="signup">회원가입</button></div><button class="recommend" data-action="demo-login" style="margin-top:12px">데모로 하기</button><p class="muted" style="margin-top:8px;font-size:12px">데모 미션 기록·사진은 이 브라우저에만 저장돼요. 후기는 공개 커뮤니티에 등록할 수 있어요.</p></section></div>`;
}

function reviewModal() {
  return `<div class="modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close" aria-label="닫기">×</button><h2>후기 작성하기</h2><label class="field">체험한 활동<select id="review-activity"><option>광안리 SUP</option><option>송정 서핑</option><option>국립해양박물관</option><option>다대포 해변 산책</option><option>기타 부산 바다 체험</option></select></label><label class="field" style="margin-top:12px">제목<input id="review-title" maxlength="80" placeholder="후기 제목"></label><label class="field" style="margin-top:12px">별점<select id="review-rating"><option value="5">5점</option><option value="4">4점</option><option value="3">3점</option><option value="2">2점</option><option value="1">1점</option></select></label><label class="field" style="margin-top:12px">후기 내용<textarea id="review-body" maxlength="500" placeholder="다른 사람에게 도움이 될 경험을 적어 주세요."></textarea></label><button class="recommend" data-action="submit-review">후기 등록하기</button></section></div>`;
}

const defaultSeaPlaces = [
  { name: '광안리 해수욕장', type: '해변', icon: '🏖', latitude: 35.1532, longitude: 129.1187 },
  { name: '송정 해수욕장', type: '해변', icon: '🏖', latitude: 35.1785, longitude: 129.1995 },
  { name: '광안리 SUP 체험', type: '바다 레저', icon: '🏄', latitude: 35.1532, longitude: 129.1187 },
  { name: '송정 서핑 입문', type: '바다 레저', icon: '🏄', latitude: 35.1785, longitude: 129.1995 }
];

const coastalAreas = [
  { name: '다대포 해수욕장', latitude: 35.0485, longitude: 128.9656 },
  { name: '송도 해수욕장', latitude: 35.0774, longitude: 129.0176 },
  { name: '광안리 해수욕장', latitude: 35.1532, longitude: 129.1187 },
  { name: '해운대 해수욕장', latitude: 35.1587, longitude: 129.1604 },
  { name: '송정 해수욕장', latitude: 35.1785, longitude: 129.1995 },
  { name: '기장 연화리 해안', latitude: 35.2285, longitude: 129.2270 }
];

const missionAreas = [
  { id: 'gwangalli', name: '광안리·민락', latitude: 35.1532, longitude: 129.1187, keywords: ['광안리', '민락'] },
  { id: 'haeundae', name: '해운대·청사포·송정', latitude: 35.165, longitude: 129.18, keywords: ['해운대', '청사포', '송정'] },
  { id: 'yeongdo', name: '영도·자갈치·송도', latitude: 35.0782, longitude: 129.0803, keywords: ['영도', '흰여울', '자갈치', '송도', '해양박물관', '감천', '북항', '부산항'] },
  { id: 'dadaepo', name: '다대포', latitude: 35.0485, longitude: 128.9656, keywords: ['다대포'] },
  { id: 'gijang', name: '기장', latitude: 35.2285, longitude: 129.2270, keywords: ['기장'] },
  { id: 'oryukdo', name: '오륙도', latitude: 35.0989, longitude: 129.1214, keywords: ['오륙도'] }
];

function missionAreaFor(mission) {
  const text = `${mission.title} ${mission.location}`;
  return missionAreas.find((area) => area.keywords.some((keyword) => text.includes(keyword))) || null;
}

function destinationFromText(query) {
  const normalized = query.replace(/\s/g, '');
  const area = missionAreas.find((item) => [item.name, ...item.keywords].some((keyword) => normalized.includes(keyword.replace(/\s/g, ''))));
  if (area) return area;
  const matchingMission = data.missions.find((mission) => `${mission.title}${mission.location}`.replace(/\s/g, '').includes(normalized));
  return matchingMission ? missionAreaFor(matchingMission) : null;
}

function coastDistanceKm(first, second) {
  const radians = (value) => value * Math.PI / 180;
  const lat = radians(second.latitude - first.latitude);
  const lng = radians(second.longitude - first.longitude);
  const value = Math.sin(lat / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(lng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const nearbyCoastalAreas = (position) => coastalAreas.filter((area) => coastDistanceKm(position, area) <= 12).sort((a, b) => coastDistanceKm(position, a) - coastDistanceKm(position, b)).slice(0, 3);

function addMapMarker(map, place) {
  const marker = L.marker([place.latitude, place.longitude], {
    icon: L.divIcon({ className: 'sea-pin', html: `<div style="font-size:25px;filter:drop-shadow(0 2px 2px #1238)">${place.icon}</div>`, iconSize: [30, 34], iconAnchor: [15, 30] })
  }).addTo(map);
  marker.bindPopup(`<b>${escapeHtml(place.name)}</b><br><span>${escapeHtml(place.type)}</span>`);
  return marker;
}

function initSeaMap() {
  const container = document.querySelector('#nearby-map');
  if (!container || !window.L) return;
  const nearestCoast = !mapFocus && userPosition ? nearbyCoastalAreas(userPosition)[0] : null;
  const target = mapFocus || nearestCoast || userPosition;
  const center = target ? [target.latitude, target.longitude] : [35.1595, 129.1593];
  seaMap = L.map('nearby-map', { zoomControl: true, scrollWheelZoom: true, tap: true }).setView(center, mapFocus ? 15 : nearestCoast ? 13 : userPosition ? 14 : 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(seaMap);
  if (mapFocus) {
    const marker = addMapMarker(seaMap, mapFocus);
    marker.openPopup();
    loadNearbySeaPlaces(seaMap, mapFocus);
  } else if (userPosition) {
    L.circleMarker([userPosition.latitude, userPosition.longitude], { radius: 9, color: '#fff', weight: 3, fillColor: '#ff8068', fillOpacity: 1 }).addTo(seaMap).bindPopup('<b>현재 위치</b>');
    if (nearestCoast) addMapMarker(seaMap, { ...nearestCoast, type: '가까운 바닷가', icon: '🏖' }).openPopup();
    loadNearbySeaPlaces(seaMap, userPosition);
  } else {
    defaultSeaPlaces.forEach((place) => addMapMarker(seaMap, place));
  }
}

async function loadNearbySeaPlaces(map, position) {
  const token = ++nearbyLoadToken;
  const areas = nearbyCoastalAreas(position);
  if (!areas.length) {
    defaultSeaPlaces.forEach((place) => addMapMarker(map, place));
    return showToast('가까운 부산 해변을 찾지 못해 대표 바다 장소를 표시했어요.');
  }
  const areaQueries = areas.map((area) => `nwr(around:1700,${area.latitude},${area.longitude})["amenity"="cafe"];nwr(around:1700,${area.latitude},${area.longitude})["amenity"="restaurant"]["cuisine"~"seafood|fish|sushi",i];nwr(around:1700,${area.latitude},${area.longitude})["amenity"="restaurant"]["name"~"횟집|회센터|수산|활어|해산물|조개|대게",i];nwr(around:1700,${area.latitude},${area.longitude})["tourism"~"attraction|museum|viewpoint|information|aquarium|gallery",i];nwr(around:1700,${area.latitude},${area.longitude})["leisure"~"marina|water_park|beach_resort",i];nwr(around:1700,${area.latitude},${area.longitude})["sport"~"surfing|sailing|scuba_diving|swimming|kayak|paddleboarding|fishing",i];nwr(around:1700,${area.latitude},${area.longitude})["shop"~"sports|outdoor|scuba_diving|water_sports|fishing",i];nwr(around:1700,${area.latitude},${area.longitude})["rental"~"boat|kayak|surfboard|scuba_diving|fishing",i];`).join('');
  const query = `[out:json][timeout:25];(${areaQueries});out center 250;`;
  try {
    const response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('nearby places request failed');
    const result = await response.json();
    if (token !== nearbyLoadToken || map !== seaMap) return;
    const shown = new Set();
    result.elements.forEach((item) => {
      const key = `${item.type}-${item.id}`;
      if (shown.has(key)) return;
      shown.add(key);
      const latitude = item.lat ?? item.center?.lat;
      const longitude = item.lon ?? item.center?.lon;
      if (!latitude || !longitude) return;
      const tags = item.tags || {};
      const isGearShop = tags.shop || tags.rental;
      const isTourism = tags.tourism;
      const isSeaLeisure = tags.sport || tags.leisure;
      const seafood = /seafood|fish|sushi/i.test(tags.cuisine || '') || /회|수산|해산물|조개|대게/.test(tags.name || '');
      const type = tags.natural === 'beach' || tags.natural === 'coastline' ? '바닷가' : tags.amenity === 'restaurant' ? '횟집·해산물 음식점' : tags.amenity === 'cafe' ? '바다 카페' : isTourism ? '해양 관광' : isGearShop ? '해양 용품·대여점' : isSeaLeisure ? '바다 레저' : '바다 주변 장소';
      const icon = type === '바닷가' ? '🏖' : type === '횟집·해산물 음식점' ? '🐟' : type === '바다 카페' ? '☕' : type === '해양 관광' ? '📍' : type === '해양 용품·대여점' ? '🧰' : '🏄';
      addMapMarker(map, { name: tags.name || type, type, icon, latitude, longitude });
    });
  } catch (error) {
    if (token === nearbyLoadToken) {
      defaultSeaPlaces.forEach((place) => addMapMarker(map, place));
      showToast('주변 장소 정보를 불러오지 못해 부산 기본 장소를 표시했어요.');
    }
  }
}

async function searchMapPlace() {
  const input = document.querySelector('#map-search');
  const keyword = input?.value.trim();
  if (!keyword) return showToast('찾을 해변이나 지역 이름을 입력해 주세요.');
  showToast('지도에서 장소를 찾고 있어요.');
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=kr&q=${encodeURIComponent(`부산 ${keyword}`)}`);
    const places = await response.json();
    if (!places.length || !seaMap) throw new Error('place not found');
    const place = places[0];
    const position = { latitude: Number(place.lat), longitude: Number(place.lon) };
    seaMap.setView([position.latitude, position.longitude], 14);
    L.marker([position.latitude, position.longitude]).addTo(seaMap).bindPopup(`<b>${escapeHtml(place.display_name.split(',')[0])}</b><br>검색한 장소`).openPopup();
    loadNearbySeaPlaces(seaMap, position);
    showToast('검색한 장소 주변의 바다 정보를 표시했어요.');
  } catch {
    showToast('장소를 찾지 못했어요. 부산 지역이나 해변 이름으로 다시 검색해 주세요.');
  }
}

function bookingModal() {
  const item = bookingActivity;
  const people = Number(leisureFilter.people);
  const total = item.cost * people;
  const usable = Math.min(data.currentUser.points, total);
  return `<div class="modal"><section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close" aria-label="닫기">×</button><h2>${item.emoji} ${item.title} 예약 체험</h2><p class="muted">실제 예약이나 결제는 진행되지 않는 연습 화면입니다.</p><div class="notice" style="margin-top:12px">1명 기준 체험 금액(예시) <b>${won(item.cost)}</b><br>보유 포인트 <b>${data.currentUser.points.toLocaleString()}P</b> (1P = 1원 할인)</div><label class="field" style="margin-top:12px">예약 인원 (필수)<select id="booking-people">${[1,2,3,4,5,6].map((count) => `<option value="${count}" ${count === people ? 'selected' : ''}>${count}명${count === 6 ? ' 이상' : ''}</option>`).join('')}</select></label><label class="field" style="margin-top:12px">체험 날짜<input id="booking-date" type="date" required></label><label class="field" style="margin-top:12px">체험 시간<select id="booking-time"><option>10:00</option><option>13:00</option><option>15:30</option></select></label><label class="field" style="margin-top:12px">사용할 포인트<input id="booking-points" type="number" min="0" max="${usable}" value="${usable}"></label><p class="muted">예약 인원에 따라 금액과 포인트 사용 가능 범위를 계산합니다.</p><div class="card-actions"><button class="secondary" data-action="close">취소</button><button class="start" data-action="confirm-booking">예약 내용 확인</button></div></section></div>`;
}

function render() {
  const pages = { home, missions, detail: missionDetail, leisure, community, profile, points };
  if (seaMap) { seaMap.remove(); seaMap = null; }
  app.innerHTML = (header() + pages[screen]() + navigation()).replace(/🛟/g, '✓');
  if (screen === 'home') setTimeout(initSeaMap, 0);
  if (screen === 'leisure') loadBusanWeather();
}

async function loadCommunityPosts() {
  if (!supabase) return;
  const { data: posts, error } = await supabase.from('community_posts').select('*').order('created_at', { ascending: false });
  if (error) { console.error(error); showToast('후기를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'); return; }
  communityPosts = posts || [];
  if (screen === 'community') render();
}

async function submitAuth(type) {
  if (!supabase) return showToast('회원 기능 연결을 불러오지 못했어요. 인터넷 연결 후 새로고침해 주세요.');
  const username = document.querySelector('#auth-username').value.trim().toLowerCase();
  const password = document.querySelector('#auth-password').value;
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) return showToast('아이디는 영문, 숫자, . _ - 로 3~20자 입력해 주세요.');
  if (password.length < 6) return showToast('비밀번호는 6자 이상으로 입력해 주세요.');
  if (type === 'signup' && !document.querySelector('#auth-consent').checked) return showToast('회원가입 전 서비스 이용 동의에 체크해 주세요.');
  const email = `${username}@cashbada.local`;
  const result = type === 'signup'
    ? await supabase.auth.signUp({ email, password, options: { data: { username } } })
    : await supabase.auth.signInWithPassword({ email, password });
  if (result.error) return showToast(result.error.message.includes('already') ? '이미 사용 중인 아이디예요. 로그인해 주세요.' : '아이디 또는 비밀번호를 확인해 주세요.');
  currentUser = result.data.user || result.data.session?.user;
  loadProgress();
  document.querySelector('.modal')?.remove();
  screen = 'profile';
  render();
  showToast(type === 'signup' ? '회원가입이 완료되었어요!' : '로그인했어요!');
}

async function submitReview() {
  const activity = document.querySelector('#review-activity').value;
  const title = document.querySelector('#review-title').value.trim();
  const body = document.querySelector('#review-body').value.trim();
  const rating = Number(document.querySelector('#review-rating').value);
  if (!title || !body) return showToast('제목과 후기 내용을 모두 입력해 주세요.');
  if (!supabase) {
    communityPosts.unshift({ id: `demo-${Date.now()}`, author: usernameFromUser(currentUser), activity, title, rating, body, created_at: new Date().toISOString() });
    document.querySelector('.modal')?.remove();
    screen = 'community';
    render();
    showToast('후기가 이 기기 화면에 등록되었어요.');
    return;
  }
  const { error } = await supabase.from('community_posts').insert({ user_id: currentUser.id, author: usernameFromUser(currentUser), activity, title, rating, body });
  if (error) { console.error(error); return showToast('후기 등록에 실패했어요. 잠시 후 다시 시도해 주세요.'); }
  document.querySelector('.modal')?.remove();
  screen = 'community';
  await loadCommunityPosts();
  showToast('후기가 등록되어 다른 사람에게도 보여요.');
}

function recommendMissions() {
  const budget = Number(document.querySelector('#budget').value);
  const interest = document.querySelector('#interest').value;
  missionDestination = document.querySelector('#mission-destination').value;
  missionPlaceQuery = document.querySelector('#mission-place-query').value.trim();
  const selectedArea = missionPlaceQuery
    ? destinationFromText(missionPlaceQuery)
    : missionDestination === 'current'
    ? userPosition
    : missionAreas.find((area) => area.id === missionDestination);
  if (missionPlaceQuery && !selectedArea) return showToast('입력한 장소와 가까운 미션을 찾지 못했어요. 광안리, 해운대, 자갈치시장처럼 입력해 주세요.');
  if (missionDestination === 'current' && !userPosition && !missionPlaceQuery) return requestLocation();
  if (!selectedArea) return showToast('목적지나 현재 위치를 선택해 주세요.');
  const candidates = data.missions.filter((m) => m.cost <= budget && (interest === '전체' || m.category === interest));
  const nearby = candidates.map((mission) => {
    const area = missionAreaFor(mission);
    return { mission, distance: area ? coastDistanceKm(selectedArea, area) : Number.MAX_SAFE_INTEGER };
  }).filter(({ distance }) => distance <= 8).sort((first, second) => first.distance - second.distance).map(({ mission }) => mission);
  recommendations = nearby.slice(0, 6);
  render();
  if (recommendations.length) showToast(`${missionPlaceQuery || (missionDestination === 'current' ? '현재 위치' : selectedArea.name)} 주변 미션만 보여드려요.`);
}

async function loadBusanWeather() {
  const target = document.querySelector('#weather-status');
  if (!target) return;
  try {
    const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=35.1796&longitude=129.0756&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia%2FSeoul');
    const weather = await response.json();
    const clear = weather.current.weather_code <= 3;
    target.innerHTML = `<span class="leisure-icon">${clear ? '🌤️' : '🌦️'}</span><strong>지금 부산 날씨: ${clear ? '맑음 또는 구름 조금' : '현장 날씨 확인 필요'}</strong><br>${weather.current.temperature_2m}℃ · 바람 ${weather.current.wind_speed_10m}km/h`;
  } catch { target.textContent = '날씨 정보를 불러오지 못했어요. 현장 안전 안내를 확인해 주세요.'; }
}

function weatherSafetyMessage(temperature, wind, wave) {
  if (wave >= 1.5) return '파도가 거셀 수 있으니 해안 가까이에서 활동하고, 수상 레저는 현장 안전 안내를 꼭 확인하세요.';
  if (wind >= 25) return '바람이 강하니 모자와 물건이 날리지 않게 하고, 수상 활동은 운영 여부를 먼저 확인하세요.';
  if (temperature >= 30) return '기온이 높아 모래와 시설물이 뜨거울 수 있으니 화상과 탈수에 주의하세요.';
  if (temperature <= 8) return '기온이 낮으니 젖은 옷을 오래 입지 말고 방풍 옷을 준비하세요.';
  return '날씨는 비교적 안정적이지만, 바다 활동 전 현장 안전 안내와 파도 상태를 다시 확인하세요.';
}

async function loadBusanWeather() {
  const target = document.querySelector('#weather-status');
  if (!target) return;
  try {
    const [weatherResponse, marineResponse] = await Promise.all([
      fetch('https://api.open-meteo.com/v1/forecast?latitude=35.1796&longitude=129.0756&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia%2FSeoul'),
      fetch('https://marine-api.open-meteo.com/v1/marine?latitude=35.1796&longitude=129.0756&current=wave_height&timezone=Asia%2FSeoul&cell_selection=sea')
    ]);
    if (!weatherResponse.ok || !marineResponse.ok) throw new Error('weather request failed');
    const weather = await weatherResponse.json();
    const marine = await marineResponse.json();
    const temperature = weather.current.temperature_2m;
    const wind = weather.current.wind_speed_10m;
    const wave = marine.current?.wave_height ?? 0;
    const clear = weather.current.weather_code <= 3;
    target.innerHTML = `<span class="leisure-icon">${clear ? '🌤️' : '🌦️'}</span><strong>지금 부산 날씨: ${clear ? '맑음 또는 구름 조금' : '현장 날씨 확인 필요'}</strong><br>기온 ${temperature}℃ · 바람 ${wind}km/h · 파도 ${wave}m<br><b>오늘의 주의:</b> ${weatherSafetyMessage(temperature, wind, wave)}<br><small>날씨·파도 정보는 예보이며, 출발 전 현장 안전 안내를 확인하세요.</small>`;
  } catch {
    target.textContent = '날씨·파도 정보를 불러오지 못했어요. 출발 전 현장 안전 안내를 확인해 주세요.';
  }
}

function requestLocation() {
  if (!navigator.geolocation) return showToast('이 브라우저에서는 위치 기능을 사용할 수 없어요.');
  showToast('현재 위치 권한을 요청하고 있어요.');
  navigator.geolocation.getCurrentPosition((position) => { userPosition = { latitude: position.coords.latitude, longitude: position.coords.longitude }; mapFocus = null; screen = 'home'; render(); showToast('현재 위치 중심으로 바다 지도를 바꿨어요.'); }, () => showToast('위치 권한이 없어 부산 바다 기본 지도를 보여드려요.'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action], [data-go]');
  if (!button) return;
  if (button.dataset.go) { screen = button.dataset.go; render(); if (screen === 'community') loadCommunityPosts(); return; }
  const action = button.dataset.action;
  if (action === 'location') requestLocation();
  if (action === 'map-search') searchMapPlace();
  if (action === 'filter') { document.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('active')); button.classList.add('active'); }
  if (action === 'place') { chosenPlace = data.places.find((p) => p.id === button.dataset.id); render(); }
  if (action === 'save') showToast('저장 목록 기능은 준비 중이에요.');
  if (action === 'place-missions') { screen = 'missions'; render(); }
  if (action === 'recommend') recommendMissions();
  if (action === 'mission') { chosenMission = data.missions.find((m) => m.id === button.dataset.id); screen = 'detail'; render(); }
  if (action === 'complete') { if (!currentUser) { showToast('미션 인증을 저장하려면 먼저 로그인해 주세요.'); await openAuthModal(); return; } const m = data.missions.find((item) => item.id === button.dataset.id); await submitMissionVerification(m); }
  if (action === 'mood') { selectedMood = button.dataset.value; document.querySelectorAll('[data-action="mood"]').forEach((item) => item.classList.toggle('active', item.dataset.value === selectedMood)); }
  if (action === 'memory-weather') { selectedWeather = button.dataset.value; document.querySelectorAll('[data-action="memory-weather"]').forEach((item) => item.classList.toggle('active', item.dataset.value === selectedWeather)); }
  if (action === 'memory-detail') { const memory = missionMemories.find((item) => item.missionId === button.dataset.id); if (memory) await openMissionMemory(memory); }
  if (action === 'apply-leisure-filter') { leisureFilter = { people: document.querySelector('#leisure-people').value, age: document.querySelector('#leisure-age').value }; render(); }
  if (action === 'like-leisure') {
    if (!currentUser) { showToast('저장하려면 먼저 로그인해 주세요.'); await openAuthModal(); return; }
    const id = button.dataset.id;
    const wasSaved = savedLeisureIds.includes(id);
    savedLeisureIds = wasSaved ? savedLeisureIds.filter((item) => item !== id) : [...savedLeisureIds, id];
    saveSavedLeisure();
    render();
    showToast(wasSaved ? '저장 목록에서 뺐어요.' : '마이 페이지의 저장한 레저에 담았어요.');
  }
  if (action === 'map') {
    const item = data.leisureActivities.find((activity) => activity.id === button.dataset.id);
    if (!item) return showToast('지도에서 표시할 레저 장소를 찾지 못했어요.');
    mapFocus = { name: item.title, type: item.type, icon: item.emoji, latitude: item.latitude, longitude: item.longitude };
    screen = 'home';
    render();
    showToast(`${item.title} 위치를 지도에 표시했어요.`);
  }
  if (action === 'inquiry') showToast('프로토타입에서는 예시 안내를 보여줍니다.');
  if (action === 'booking') {
    if (!currentUser) { showToast('포인트를 사용하려면 먼저 로그인해 주세요.'); await openAuthModal(); return; }
    bookingActivity = data.leisureActivities.find((item) => item.id === button.dataset.id);
    app.insertAdjacentHTML('beforeend', bookingModal());
  }
  if (action === 'auth-form') openAuthModal();
  if (action === 'review-form') {
    if (!currentUser) { showToast('후기를 작성하려면 먼저 로그인해 주세요.'); await openAuthModal(); return; }
    app.insertAdjacentHTML('beforeend', reviewModal());
  }
  if (action === 'close') document.querySelector('.modal')?.remove();
  if (action === 'signup') submitAuth('signup');
  if (action === 'signin') submitAuth('signin');
  if (action === 'demo-login') await startDemo();
  if (action === 'submit-review') submitReview();
  if (action === 'confirm-booking') {
    const people = Number(document.querySelector('#booking-people')?.value);
    if (!Number.isInteger(people) || people < 1) return showToast('예약 인원을 선택해 주세요.');
    const points = Number(document.querySelector('#booking-points').value);
    const total = bookingActivity.cost * people;
    const available = Math.min(data.currentUser.points, total);
    if (!Number.isInteger(points) || points < 0 || points > available) return showToast(`0P부터 ${available.toLocaleString()}P까지 입력해 주세요.`);
    data.currentUser.points -= points;
    saveProgress();
    document.querySelector('.modal')?.remove();
    render();
    showToast(`${people}명 예약 체험 완료! ${points.toLocaleString()}P 할인 적용 (결제는 진행되지 않았어요).`);
  }
  if (action === 'signout') await signOut();
});

async function loadCommunityPosts() {
  try {
    const sharedPosts = await supabaseRequest('/rest/v1/community_posts?select=*&order=created_at.desc') || [];
    communityPosts = isDemoUser() ? [...getDemoReviews(), ...sharedPosts] : sharedPosts;
    if (screen === 'community') render();
  } catch (error) { console.error('후기 불러오기 오류:', error); }
}

async function submitAuth(type) {
  const username = document.querySelector('#auth-username')?.value.trim().toLowerCase();
  const password = document.querySelector('#auth-password')?.value;
  if (!username || !/^[a-z0-9._-]{3,20}$/.test(username)) return showToast('아이디는 영문, 숫자, . _ - 로 3~20자 입력해 주세요.');
  if (!password || password.length < 6) return showToast('비밀번호는 6자 이상으로 입력해 주세요.');
  if (type === 'signup' && !document.querySelector('#auth-consent')?.checked) return showToast('회원가입 및 서비스 이용 동의를 체크해 주세요.');
  const email = `${username}@cashbada.local`;
  try {
    const result = type === 'signup'
      ? await supabaseRequest('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password, data: { username } }) })
      : await supabaseRequest('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!result?.access_token || !result?.user) {
      return showToast('가입이 완료됐어요. 같은 아이디와 비밀번호로 로그인해 주세요.');
    }
    saveSession(result);
    currentUser = result.user;
    loadProgress();
    loadSavedLeisure();
    await loadMissionMemories();
    await loadCloudProgress();
    await migrateLocalPhotosToCloud();
    document.querySelector('.modal')?.remove();
    screen = 'profile';
    render();
    showToast(type === 'signup' ? '회원가입이 완료됐어요!' : '로그인했어요!');
  } catch (error) {
    const message = String(error.message || '');
    console.error('로그인 오류:', error);
    showToast(message.includes('already') || message.includes('registered') ? '이미 사용 중인 아이디예요. 로그인해 주세요.' : '아이디 또는 비밀번호를 확인해 주세요.');
  }
}

async function submitReview() {
  if (!currentUser) return showToast('후기를 작성하려면 먼저 로그인해 주세요.');
  const activity = document.querySelector('#review-activity')?.value;
  const title = document.querySelector('#review-title')?.value.trim();
  const body = document.querySelector('#review-body')?.value.trim();
  const rating = Number(document.querySelector('#review-rating')?.value);
  if (!title || !body) return showToast('제목과 후기 내용을 모두 입력해 주세요.');
  if (isDemoUser()) {
    const post = { id: `demo-${Date.now()}`, author: usernameFromUser(currentUser), activity, title, rating, body, created_at: new Date().toISOString() };
    if (getStoredSession()?.access_token) {
      try {
        const saved = await supabaseRequest('/rest/v1/community_posts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: currentUser.id, author: post.author, activity, title, rating, body }) });
        if (!Array.isArray(saved) || !saved[0]?.id) throw new Error('후기 저장 확인에 실패했어요.');
        document.querySelector('.modal')?.remove();
        screen = 'community';
        await loadCommunityPosts();
        return showToast('데모 후기가 등록되어 다른 사람에게도 보여요.');
      } catch (error) { console.warn('공개 데모 후기 등록 오류:', error); }
    }
    const posts = [post, ...getDemoReviews()];
    saveDemoReviews(posts);
    communityPosts = [post, ...communityPosts];
    document.querySelector('.modal')?.remove();
    screen = 'community';
    render();
    return showToast('데모 후기를 이 브라우저에 등록했어요.');
  }
  try {
    const saved = await supabaseRequest('/rest/v1/community_posts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: currentUser.id, author: usernameFromUser(currentUser), activity, title, rating, body }) });
    if (!Array.isArray(saved) || !saved[0]?.id) throw new Error('후기 저장 확인에 실패했어요.');
    document.querySelector('.modal')?.remove();
    screen = 'community';
    await loadCommunityPosts();
    showToast('후기가 등록되어 다른 사람에게도 보여요.');
  } catch (error) { console.error('후기 등록 오류:', error); showToast('후기 등록에 실패했어요. 로그인 상태를 확인해 주세요.'); }
}

async function initialize() {
  render();
  if (supabase) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      currentUser = session?.user || null;
      supabase.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user || null;
        loadProgress();
        render();
      });
    } catch (error) { console.error('로그인 정보 확인 오류:', error); }
  }
  currentUser = getStoredSession()?.user || null;
  loadProgress();
  loadSavedLeisure();
  await loadMissionMemories();
  await loadCloudProgress();
  await migrateLocalPhotosToCloud();
  render();
}

initialize();
setInterval(() => {
  if (!resetDailyMissionsIfNeeded()) return;
  saveProgress();
  render();
  showToast('새로운 하루예요. 오늘의 미션 참여 수가 초기화됐어요!');
}, 30000);
