/* مُدرَج - أدوات مشتركة: نوافذ منبثقة مخصصة (بدل alert/confirm/prompt) + الوضع الداكن */

// ===== تطبيق الوضع الداكن فورًا (قبل رسم الصفحة عشان ما يصير وميض) =====
(function(){
  const dark = localStorage.getItem('mudraj_dark') === '1';
  if(dark) document.documentElement.dataset.theme = 'dark';
})();

// ===== حقن تنسيقات النوافذ المنبثقة مرة وحدة =====
(function injectUiStyles(){
  if(document.getElementById('mudraj-ui-styles')) return;
  const style = document.createElement('style');
  style.id = 'mudraj-ui-styles';
  style.textContent = `
    .mdj-overlay{
      display:flex; position:fixed; inset:0; background:rgba(20,25,35,0.5); z-index:1000;
      align-items:center; justify-content:center; padding:20px; opacity:0; transition:opacity .18s ease;
    }
    .mdj-overlay.show{ opacity:1; }
    .mdj-box{
      background:var(--card,#fff); border:1px solid var(--line,#E4DFD1); border-radius:16px; padding:24px;
      width:100%; max-width:380px; text-align:center; transform:scale(0.9) translateY(8px); opacity:0;
      transition:transform .2s cubic-bezier(0.34,1.56,0.64,1), opacity .2s ease;
    }
    .mdj-overlay.show .mdj-box{ transform:scale(1) translateY(0); opacity:1; }
    .mdj-title{ font-size:15.5px; font-weight:700; color:var(--text,#20242E); margin-bottom:8px; font-family:inherit; }
    .mdj-msg{ font-size:13.5px; color:var(--text-mute,#5B6472); font-weight:300; line-height:1.8; margin-bottom:18px; white-space:pre-line; }
    .mdj-input{
      width:100%; padding:11px 13px; border:1px solid var(--line,#E4DFD1); border-radius:9px;
      font-family:inherit; font-size:13.5px; margin-bottom:16px; background:var(--paper,#F7F4EC); color:var(--text,#20242E);
    }
    .mdj-input:focus{ outline:none; border-color:var(--ink-soft,#2A3A63); }
    .mdj-actions{ display:flex; gap:8px; }
    .mdj-actions button{
      flex:1; padding:11px; border:none; border-radius:9px; font-family:inherit; font-size:13.5px; font-weight:600; cursor:pointer;
      transition:transform .1s ease;
    }
    .mdj-actions button:active{ transform:scale(0.96); }
    .mdj-btn-primary{ background:var(--ink,#16213E); color:#fff; }
    .mdj-btn-ghost{ background:var(--paper,#F7F4EC); color:var(--text-mute,#5B6472); }
    .mdj-btn-danger{ background:var(--danger,#B3432B); color:#fff; }
  `;
  document.head.appendChild(style);
})();

function mdjCreateOverlay(){
  const overlay = document.createElement('div');
  overlay.className = 'mdj-overlay';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return overlay;
}
function mdjClose(overlay, resolve, value){
  overlay.classList.remove('show');
  setTimeout(() => { overlay.remove(); resolve(value); }, 180);
}

// ===== بديل alert() =====
function uiAlert(message, title){
  return new Promise(resolve => {
    const overlay = mdjCreateOverlay();
    overlay.innerHTML = `
      <div class="mdj-box">
        ${title ? `<div class="mdj-title">${title}</div>` : ''}
        <div class="mdj-msg">${message}</div>
        <div class="mdj-actions"><button class="mdj-btn-primary" id="mdjOk">تمام</button></div>
      </div>`;
    overlay.querySelector('#mdjOk').onclick = () => mdjClose(overlay, resolve, true);
  });
}

// ===== بديل confirm() =====
function uiConfirm(message, title, danger){
  return new Promise(resolve => {
    const overlay = mdjCreateOverlay();
    overlay.innerHTML = `
      <div class="mdj-box">
        ${title ? `<div class="mdj-title">${title}</div>` : ''}
        <div class="mdj-msg">${message}</div>
        <div class="mdj-actions">
          <button class="mdj-btn-ghost" id="mdjCancel">إلغاء</button>
          <button class="${danger ? 'mdj-btn-danger' : 'mdj-btn-primary'}" id="mdjConfirm">تأكيد</button>
        </div>
      </div>`;
    overlay.querySelector('#mdjCancel').onclick = () => mdjClose(overlay, resolve, false);
    overlay.querySelector('#mdjConfirm').onclick = () => mdjClose(overlay, resolve, true);
    overlay.onclick = (e) => { if(e.target === overlay) mdjClose(overlay, resolve, false); };
  });
}

// ===== بديل prompt() =====
function uiPrompt(message, defaultValue, title){
  return new Promise(resolve => {
    const overlay = mdjCreateOverlay();
    overlay.innerHTML = `
      <div class="mdj-box">
        ${title ? `<div class="mdj-title">${title}</div>` : ''}
        <div class="mdj-msg">${message}</div>
        <input class="mdj-input" id="mdjInput" value="${defaultValue || ''}">
        <div class="mdj-actions">
          <button class="mdj-btn-ghost" id="mdjCancel">إلغاء</button>
          <button class="mdj-btn-primary" id="mdjOk">حفظ</button>
        </div>
      </div>`;
    const input = overlay.querySelector('#mdjInput');
    input.focus();
    input.select();
    input.addEventListener('keydown', e => { if(e.key === 'Enter') submit(); });
    function submit(){ mdjClose(overlay, resolve, input.value); }
    overlay.querySelector('#mdjCancel').onclick = () => mdjClose(overlay, resolve, null);
    overlay.querySelector('#mdjOk').onclick = submit;
  });
}

// ===== بديل prompt() باختيار من قائمة (زر لكل خيار) =====
function uiChoose(message, choices, title){
  // choices: [{label, value}]
  return new Promise(resolve => {
    const overlay = mdjCreateOverlay();
    overlay.innerHTML = `
      <div class="mdj-box">
        ${title ? `<div class="mdj-title">${title}</div>` : ''}
        <div class="mdj-msg">${message}</div>
        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:14px;" id="mdjChoices"></div>
        <div class="mdj-actions"><button class="mdj-btn-ghost" id="mdjCancel" style="flex:1;">إلغاء</button></div>
      </div>`;
    const list = overlay.querySelector('#mdjChoices');
    choices.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'mdj-btn-ghost';
      btn.style.textAlign = 'right';
      btn.textContent = c.label;
      btn.onclick = () => mdjClose(overlay, resolve, c.value);
      list.appendChild(btn);
    });
    overlay.querySelector('#mdjCancel').onclick = () => mdjClose(overlay, resolve, null);
  });
}
