const FORMAT = {
  blur: (v) => v + ' px',
  dim: (v) => Math.round(v * 100) + '%',
  saturate: (v) => Number(v).toFixed(1) + '×',
  fps: (v) => v + ' fps'
};

function render(s) {
  for (const k of Object.keys(YTBB_DEFAULTS)) {
    const el = document.getElementById(k);
    if (el.type === 'checkbox') el.checked = s[k];
    else el.value = s[k];
    const out = document.getElementById(k + '-val');
    if (out) out.textContent = FORMAT[k](s[k]);
  }
}

chrome.storage.sync.get(YTBB_DEFAULTS, render);

for (const k of Object.keys(YTBB_DEFAULTS)) {
  const el = document.getElementById(k);
  el.addEventListener('input', () => {
    const v = el.type === 'checkbox' ? el.checked : Number(el.value);
    const out = document.getElementById(k + '-val');
    if (out) out.textContent = FORMAT[k](v);
    chrome.storage.sync.set({ [k]: v });
  });
}

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.sync.set(YTBB_DEFAULTS);
  render(YTBB_DEFAULTS);
});
