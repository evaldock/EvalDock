// Compact presentation controls; all advanced toggles remain available.
const workspace=document.querySelector('.workspace');
const compact=document.createElement('div');compact.className='compact-tools';
workspace.querySelector('.toolbar').after(compact);
compact.append($('reviewBar'),$('groupNav'));
const settings=document.createElement('button');settings.id='displaySettings';settings.textContent='显示设置';settings.setAttribute('aria-expanded','false');workspace.querySelector('.toolbar').append(settings);
settings.onclick=()=>{const open=workspace.classList.toggle('show-settings');settings.setAttribute('aria-expanded',String(open));settings.textContent=open?'收起设置':'显示设置';};

const viewTabs=document.querySelector('.view-tabs');viewTabs.prepend(viewTabs.querySelector('[data-view="records"]'));viewTabs.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===mode));
