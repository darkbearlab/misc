(() => {
  'use strict';

  const CANVAS_WIDTH = 160; // 模糊後細節看不到，用小解析度省效能
  const html = document.documentElement;

  let settings = { ...YTBB_DEFAULTS };
  let video = null;
  let rafId = 0;
  let lastDraw = 0;
  let lastVideoTime = -1;
  let dirty = true;

  const root = document.createElement('div');
  root.id = 'ytbb-root';
  const canvas = document.createElement('canvas');
  canvas.id = 'ytbb-canvas';
  const overlay = document.createElement('div');
  overlay.id = 'ytbb-overlay';
  root.append(canvas, overlay);
  const ctx = canvas.getContext('2d', { alpha: false });

  function mountRoot() {
    // 全螢幕時只有全螢幕元素會被畫出來，所以背景層要搬進去
    const fs = document.fullscreenElement;
    const parent = fs && fs !== html ? fs : document.body;
    if (parent && root.parentNode !== parent) parent.prepend(root);
    dirty = true;
  }

  function applyStyle() {
    html.style.setProperty('--ytbb-blur', settings.blur + 'px');
    html.style.setProperty('--ytbb-dim', String(settings.dim));
    html.style.setProperty('--ytbb-saturate', String(settings.saturate));
    html.classList.toggle('ytbb-letterbox', !!settings.letterbox);
    dirty = true;
  }

  function findVideo() {
    if (!location.pathname.startsWith('/watch')) return null;
    const v = document.querySelector('#movie_player video.html5-main-video');
    return v && v.isConnected ? v : null;
  }

  function resizeCanvas() {
    const w = CANVAS_WIDTH;
    const h = Math.max(1, Math.round(w * innerHeight / Math.max(1, innerWidth)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      dirty = true;
    }
  }

  function draw() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const cw = canvas.width, ch = canvas.height;
    // 等同 object-fit: cover
    const s = Math.max(cw / vw, ch / vh);
    const dw = vw * s, dh = vh * s;
    try {
      ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    } catch (_) {
      return;
    }
    lastVideoTime = video.currentTime;
    dirty = false;
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!video || document.hidden || video.readyState < 2) return;
    if (now - lastDraw < 1000 / settings.fps) return;
    // 暫停中畫面沒變就不重畫
    if (!dirty && video.currentTime === lastVideoTime) return;
    lastDraw = now;
    draw();
  }

  function update() {
    const v = settings.enabled ? findVideo() : null;
    if (v !== video) {
      video = v;
      dirty = true;
    }
    const active = !!video;
    html.classList.toggle('ytbb-active', active);
    if (active) {
      if (!root.isConnected) mountRoot();
      resizeCanvas();
      if (!rafId) rafId = requestAnimationFrame(loop);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  chrome.storage.sync.get(YTBB_DEFAULTS, (stored) => {
    settings = { ...YTBB_DEFAULTS, ...stored };
    applyStyle();
    mountRoot();
    update();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in YTBB_DEFAULTS) settings[k] = newValue ?? YTBB_DEFAULTS[k];
    }
    applyStyle();
    update();
  });

  // YouTube 是單頁應用，換頁不會重新載入
  document.addEventListener('yt-navigate-finish', update);
  document.addEventListener('yt-page-data-updated', update);
  document.addEventListener('fullscreenchange', () => { mountRoot(); resizeCanvas(); });
  addEventListener('resize', resizeCanvas);
  // 保險：播放器元素偶爾會被整個換掉
  setInterval(update, 1000);
})();
