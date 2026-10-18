// app.js — Supabase 版（纯静态：GitHub Pages + Supabase 直连，无服务器）
// 数据读写走 Supabase RPC 函数（见 schema.sql）；实时消息走 Realtime 广播；在线状态走 Realtime Presence；
// 图片/视频上传走 Supabase Storage（REST 上传，保留进度条）。
(() => {
  // --------------- Supabase 初始化 ---------------
  // 配置在 config.js（window.SUPABASE_CONFIG），supabase-js 在 ./lib/supabase.min.js
  let supabase = null;
  try {
    if (window.supabase && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey) {
      const cfg = window.SUPABASE_CONFIG;
      const base = String(cfg.url).replace(/\/+$/, '');
      supabase = window.supabase.createClient(base, cfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }
  } catch (e) { console.error('Supabase init error:', e); }

  const SUPABASE_URL = supabase ? String(window.SUPABASE_CONFIG.url).replace(/\/+$/, '') : '';
  const SUPABASE_ANON_KEY = supabase ? window.SUPABASE_CONFIG.anonKey : '';

  function supabaseReady() {
    if (supabase) return true;
    toast('未配置 Supabase：请先填写 config.js 中的 url 与 anonKey', 'error');
    return false;
  }

  // --------------- DOM 元素 ---------------
  const loginView = document.getElementById('loginView');
  const app = document.getElementById('app');
  const navBtns = Array.from(document.querySelectorAll('.nav-btn'));
  const tabs = Array.from(document.querySelectorAll('.tab.view'));
  const btnRegister = document.getElementById('btn-register');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');

  // messages tab
  const conversationsPanel = document.getElementById('conversationsPanel');
  const chatPanel = document.getElementById('chatPanel');
  const conversationsList = document.getElementById('conversationsList');
  const chatTitle = document.getElementById('chatTitle');
  const friendRemarkDisplay = document.getElementById('friendRemarkDisplay');
  const backToConvos = document.getElementById('backToConvos');
  if (backToConvos) {
    backToConvos.addEventListener('click', () => {
      showConversationsPanel();
    });
  }

  const chatWindow = document.getElementById('chatWindow');
  const msgInput = document.getElementById('msgInput');
  const btnSendText = document.getElementById('btnSendText');

  // 历史消息分页状态
  const chatState = { oldestId: null, hasMore: true, loading: false };

  if (chatWindow) {
    chatWindow.addEventListener('scroll', () => {
      if (chatWindow.scrollTop <= 20 && currentFriend) loadEarlierMessages();
    });
  }

  const imgUpload = document.getElementById('imgUpload');

  // contacts tab
  const newFriendInput = document.getElementById('newFriend');
  const btnAdd = document.getElementById('btn-add');
  const friendsList = document.getElementById('friendsList');

  // me tab
  const meAvatarWrap = document.getElementById('meAvatarWrap');
  const avatarInput = document.getElementById('avatarInput');
  const btnSaveAvatar = document.getElementById('btnSaveAvatar');
  const meNote = document.getElementById('meNote');
  const DEV_NOTE = meNote.value;

  // --------------- 状态 ---------------
  let currentUser = null;
  let currentFriend = null;
  let friends = [];
  let onlineSet = new Set(); // 当前在线用户集合，局部更新用

  let unreadMap = {};
  const storedUnread = localStorage.getItem('chat_unreadMap');
  if (storedUnread) {
    try {
      unreadMap = JSON.parse(storedUnread);
      Object.keys(unreadMap).forEach(k => {
        if (typeof unreadMap[k] === 'boolean') unreadMap[k] = unreadMap[k] ? 1 : 0;
      });
    } catch(e) { unreadMap = {}; }
  }

  function updateConversationRedDot(friend) {
    const count = unreadMap[friend] || 0;
    const divs = conversationsList.querySelectorAll('.friend');
    divs.forEach(div => {
      if (div.dataset.friend === friend) {
        const dot = div.querySelector('.red-dot');
        if (dot) {
          dot.style.visibility = count > 0 ? 'visible' : 'hidden';
          dot.textContent = count > 99 ? '99+' : (count || '');
        }
      }
    });
    localStorage.setItem('chat_unreadMap', JSON.stringify(unreadMap));
    updateTotalBadge();
  }

  // --------------- 标签页图标（favicon）：默认空心爱心，有未读时空心/实心交替闪烁 ---------------
  const FAV_HOLLOW = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23111' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3C14.7 3 13.5 3.5 12 5c-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7 7-7z'/%3E%3C/svg%3E";
  const FAV_SOLID = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23111'%3E%3Cpath d='M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3C14.7 3 13.5 3.5 12 5c-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7 7-7z'/%3E%3C/svg%3E";
  let _favTimer = null;
  let _favSolid = false;
  function setFavicon(solid) {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = solid ? FAV_SOLID : FAV_HOLLOW;
  }
  function updateFaviconFlash(hasUnread) {
    if (hasUnread) {
      if (_favTimer) return;
      _favTimer = setInterval(() => { _favSolid = !_favSolid; setFavicon(_favSolid); }, 600);
    } else {
      if (_favTimer) { clearInterval(_favTimer); _favTimer = null; }
      setFavicon(false);
    }
  }
  setFavicon(false); // 初始：空心

  // 底部"消息"Tab 未读角标 + 标签页标题 + favicon 闪烁
  function updateTotalBadge() {
    let total = 0;
    Object.keys(unreadMap).forEach(k => { total += (Number(unreadMap[k]) || 0); });
    const badge = document.getElementById('navMsgBadge');
    if (badge) {
      badge.textContent = total > 99 ? '99+' : (total || '');
      badge.style.display = total > 0 ? 'block' : 'none';
    }
    updateFaviconFlash(total > 0);
    document.title = total > 0 ? `(${total}) アイチャット` : 'アイチャット';
  }

  let myAvatar = '';
  const avatarCache = {};

  // throttle / mutex
  let _loadConvTimer = null;
  let _isLoadingConversations = false;
  function throttleLoadConversations() {
    if (_isLoadingConversations) return;
    if (_loadConvTimer) return;
    _loadConvTimer = setTimeout(() => {
      _loadConvTimer = null;
      loadConversations();
    }, 50);
  }

  // --------------- toast（替代 alert）---------------
  function toast(msg, type = 'info') {
    if (!msg) return;
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    container.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }

  // --------------- UI helpers ---------------
  function showLogin() { if(loginView) loginView.style.display='block'; if(app) app.style.display='none'; document.title='アイチャット'; }
  function showApp() { if(loginView) loginView.style.display='none'; if(app) app.style.display='block'; }
  function switchTab(targetId){
    tabs.forEach(t => t.id === targetId ? t.classList.add('active') : t.classList.remove('active'));
    navBtns.forEach(b => b.dataset.target === targetId ? b.classList.add('active') : b.classList.remove('active'));
    if(targetId === 'tab-messages') throttleLoadConversations();
  }
  navBtns.forEach(b => b.addEventListener('click', ()=> switchTab(b.dataset.target)));

  function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function truncate(s,n){ if(!s) return ''; return s.length>n?s.slice(0,n-1)+'…':s; }

  // avatar
  function makeInitialsDiv(username, size=52){
    const d = document.createElement('div');
    d.className = 'avatar-initial';
    d.style.width = size + 'px';
    d.style.height = size + 'px';
    const initials = (username||'?').trim().split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase() || '?';
    d.textContent = initials;
    return d;
  }
  function makeAvatarDOM(username, url, size=52){
    const wrapper = document.createElement('div');
    wrapper.style.width = size + 'px';
    wrapper.style.height = size + 'px';
    wrapper.className = 'avatar-wrap';
    if(url && url.trim()){
      const img = document.createElement('img');
      img.src = url;
      img.alt = username;
      img.loading = 'lazy';
      img.onerror = ()=>{ wrapper.innerHTML=''; wrapper.appendChild(makeInitialsDiv(username,size)); };
      wrapper.appendChild(img);
    } else wrapper.appendChild(makeInitialsDiv(username,size));
    return wrapper;
  }
  function renderMyAvatar(){ if(!meAvatarWrap) return; meAvatarWrap.innerHTML=''; meAvatarWrap.appendChild(makeAvatarDOM(currentUser,myAvatar,52)); }

  function showConversationsPanel(){ if(conversationsPanel) conversationsPanel.style.display=''; if(chatPanel) chatPanel.style.display='none'; if(chatPanel) chatPanel.classList.remove('chat-panel-full'); window.currentFriend = null; }
  function showChatPanelFull(){ if(conversationsPanel) conversationsPanel.style.display='none'; if(chatPanel) chatPanel.style.display=''; if(chatPanel) chatPanel.classList.add('chat-panel-full'); }

  // -------- Realtime（替代 Socket.IO）--------
  // 在线状态：全局 presence 频道；消息推送：全局 broadcast 频道（只处理发给自己的消息）
  let presenceChannel = null;
  let rtChannel = null;
  let rtReady = false;

  function setupRealtime(){
    if (!supabase) return;
    if (presenceChannel || rtChannel) return; // 已监听

    // 在线状态（Presence）
    presenceChannel = supabase.channel('online');
    presenceChannel.on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState() || {};
      onlineSet = new Set();
      Object.keys(state).forEach(k => {
        (state[k] || []).forEach(p => { if (p && p.user) onlineSet.add(p.user); });
      });
      window.onlineUsersList = Array.from(onlineSet);
      friendsList.querySelectorAll('.friend').forEach(div => {
        const f = div.dataset.friend;
        if (!f) return;
        const sub = div.querySelector('.small.muted');
        if (sub) {
          const online = onlineSet.has(f);
          sub.textContent = online ? '在线' : '离线';
          sub.style.color = online ? '#22c55e' : '';
        }
      });
    });
    presenceChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && currentUser) {
        try { await presenceChannel.track({ user: currentUser }); } catch(e) {}
      }
    });

    // 消息广播（Broadcast）
    rtChannel = supabase.channel('chat');
    rtChannel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      if (payload) handleIncomingMessage(payload);
    });
    rtChannel.subscribe((status) => { if (status === 'SUBSCRIBED') rtReady = true; });
  }

  // 收到新消息（等价于旧 socket.on('receive-message')）
  function handleIncomingMessage(data) {
    if (!data || !data.from) return;
    // 只处理发给自己的消息（其他用户之间的消息不渲染、不计未读）
    if (data.to && data.to !== currentUser) return;

    // 只把消息渲染进当前打开的会话窗口；其他会话只累计未读（避免消息串进错误的窗口）
    if (currentFriend === data.from) {
      addMessageToWindow(data.from, data.message, data.ts);
    } else {
      unreadMap[data.from] = (unreadMap[data.from] || 0) + 1;
      updateConversationRedDot(data.from);
    }

    // 桌面通知（先确认浏览器支持，避免旧环境抛错）
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const notiOpts = {
        body: data.type === 'image' ? '[图片]' : (data.message.length > 50 ? data.message.slice(0, 50) + '…' : data.message),
      };
      if (avatarCache[data.from]) notiOpts.icon = avatarCache[data.from];
      const n = new Notification(data.from, notiOpts);
      n.onclick = () => {
        window.focus();
        openConversation(data.from);
        n.close();
      };
    }

    // 本地更新会话预览，不再全量重拉
    updateConversationPreview(data.from, {
      from_user: data.from, message: data.message, type: data.type, ts: data.ts
    });
    // 同步写入本地缓存
    appendMsgToCache(data.from, { from_user: data.from, message: data.message, type: data.type || 'text', ts: data.ts });
  }

  // 登录后拉取服务端未读计数（等价于旧 socket 'unread-counts'）
  async function loadUnreadCounts(){
    if (!currentUser || !supabase) return;
    try {
      const { data, error } = await supabase.rpc('get_unread_counts', { p_username: currentUser });
      if (error || !Array.isArray(data)) return;
      data.forEach(item => {
        unreadMap[item.from_user] = item.count > 0 ? item.count : 0;
        updateConversationRedDot(item.from_user);
      });
    } catch(e) { console.error('loadUnreadCounts', e); }
  }

  // --------------- Friends / Conversations ---------------
  async function loadFriends(){
    if(!currentUser) return;
    if(!supabase) return;
    try{
      const { data, error } = await supabase.rpc('get_friends', { p_username: currentUser });
      const list = error ? [] : (data || []);
      list.forEach(x=>{ if(x.avatar && x.avatar.trim()) avatarCache[x.friend]=x.avatar; });

      friends = (list||[]).map(x=>({
        friend: x.friend,
        avatar: x.avatar || '',
        remark: x.remark || ''
      }));

      renderContacts();
    }catch(e){
      friends=[];
      renderContacts();
    }
  }

  function renderContacts() {
    if (!friendsList) return;
    friendsList.innerHTML = '';

    friends.forEach(item => {
      const f = item.friend;
      const av = avatarCache[f] || item.avatar || '';
      const remark = item.remark || '';

      const div = document.createElement('div');
      div.className = 'friend';
      div.dataset.friend = f;

      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.gap = '10px';
      left.style.alignItems = 'center';
      left.appendChild(makeAvatarDOM(f, av, 44));

      const txt = document.createElement('div');
      const name = document.createElement('div');
      name.innerHTML = remark ? `${escapeHTML(remark)} (${escapeHTML(f)})` : escapeHTML(f);

      const sub = document.createElement('div');
      sub.className = 'small muted';
      const online = onlineSet.has(f);
      sub.textContent = online ? '在线' : '离线';
      if (online) sub.style.color = '#22c55e';

      txt.appendChild(name);
      txt.appendChild(sub);
      left.appendChild(txt);
      div.appendChild(left);

      div.addEventListener('click', () => {
        switchTab('tab-messages');
        openConversation(f);
      });

      const editBtn = document.createElement('button');
      editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l.7-3.3L15.6 5.8a2.1 2.1 0 0 1 3 3L7.7 19.7 4 20z"/><path d="M14.2 7.2l3 3"/></svg>备注';
      editBtn.className = 'edit-remark-btn';
      editBtn.style.marginLeft = 'auto';
      editBtn.style.padding = '4px 8px';
      editBtn.style.fontSize = '12px';
      editBtn.addEventListener('click', e => { e.stopPropagation(); editRemarkForFriend(f); });
      div.appendChild(editBtn);

      friendsList.appendChild(div);
    });
  }

  // 创建一条会话列表行（仅在该好友首次出现在列表里时新建节点）
  function createConversationRow(c) {
    const div = document.createElement('div');
    div.className = 'friend';
    div.dataset.friend = c.friend;

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '10px';
    left.appendChild(makeAvatarDOM(c.friend, c.avatar || '', 44));

    const tc = document.createElement('div');
    const title = document.createElement('div');
    title.innerHTML = c.remark ? `${escapeHTML(c.remark)} (${escapeHTML(c.friend)})` : escapeHTML(c.friend);

    const preview = document.createElement('div');
    preview.className = 'small muted conv-preview';
    const previewText = document.createElement('span');
    previewText.className = 'conv-preview-text';
    preview.appendChild(previewText);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'conv-preview-time';
    preview.appendChild(timeSpan);

    tc.appendChild(title);
    tc.appendChild(preview);
    left.appendChild(tc);
    div.appendChild(left);

    const dot = document.createElement('div');
    dot.className = 'red-dot';
    div.appendChild(dot);

    div.addEventListener('click', () => openConversation(c.friend));

    updateConversationRow(div, c);
    return div;
  }

  // 更新已有行的预览文字/时间/红点——不销毁节点、不重载头像，因此不闪
  function updateConversationRow(div, c) {
    const preview = div.querySelector('.conv-preview');
    if (preview) {
      const pt = preview.querySelector('.conv-preview-text');
      if (pt) {
        pt.textContent = c.last ?
          ((c.last.from_user === currentUser ? '你: ' : '') + (c.last.type === 'image' ? '[图片]' : truncate(c.last.message || '', 40)))
          : '暂无消息';
      }
      const ts = preview.querySelector('.conv-preview-time');
      if (ts) ts.textContent = (c.last && c.last.ts) ? formatConvTime(c.last.ts) : '';
    }
    const count = unreadMap[c.friend] || 0;
    const dot = div.querySelector('.red-dot');
    if (dot) {
      dot.style.visibility = count > 0 ? 'visible' : 'hidden';
      dot.textContent = count > 99 ? '99+' : (count || '');
    }
  }

  // 拉所有会话（每个好友最后一条消息）——缓存制：列表已有时做增量合并，节点不重建，头像不重载，避免闪烁
  async function loadConversations() {
    if (!currentUser || _isLoadingConversations) return;
    _isLoadingConversations = true;

    try {
      if (!friends || !friends.length) await loadFriends();
      if (!supabase) return;

      const { data, error } = await supabase.rpc('get_conversations', { p_username: currentUser });
      const list = error ? [] : (data || []);

      const conv = list.map(c => ({
        friend: c.friend,
        avatar: c.avatar || '',
        remark: c.remark || '',
        last: c.message ? {
          message: c.message, type: c.type, ts: c.ts, from_user: c.from_user
        } : null
      }));
      conv.sort((a,b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0));

      if (conversationsList.children.length === 0) {
        // 首次：整批创建
        const frag = document.createDocumentFragment();
        conv.forEach(c => frag.appendChild(createConversationRow(c)));
        conversationsList.appendChild(frag);
      } else {
        // 已有列表：更新已有行、新建缺失行、按时间重排。
        // appendChild 会把节点从原位置移走而非销毁重建，<img> 不会重新加载，因此不闪。
        const frag = document.createDocumentFragment();
        conv.forEach(c => {
          let div = conversationsList.querySelector(`.friend[data-friend="${CSS.escape(c.friend)}"]`);
          if (!div) div = createConversationRow(c);
          else updateConversationRow(div, c);
          frag.appendChild(div);
        });
        conversationsList.appendChild(frag);
      }

    } catch (e) { console.error(e); }
    finally { _isLoadingConversations = false; }
  }

  // 本地更新某条会话的预览文字，并把它挪到列表最上面（收到/发出消息时调用，不发请求）
  function updateConversationPreview(friend, lastMsg) {
    let div = conversationsList.querySelector(`.friend[data-friend="${CSS.escape(friend)}"]`);
    if (!div) {
      // 会话列表里还没有这一行（新会话或列表尚未加载）：静默刷新补上，未读红点/预览才会更新
      throttleLoadConversations();
      return;
    }
    const preview = div.querySelector('.conv-preview');
    if (preview && lastMsg) {
      const pt = preview.querySelector('.conv-preview-text');
      if (pt) {
        pt.textContent = (lastMsg.from_user === currentUser ? '你: ' : '') +
          (lastMsg.type === 'image' ? '[图片]' : truncate(lastMsg.message || '', 40));
      }
      const timeSpan = preview.querySelector('.conv-preview-time');
      if (timeSpan) timeSpan.textContent = formatConvTime(lastMsg.ts);
    }
    // 挪到最上面
    conversationsList.insertBefore(div, conversationsList.firstChild);
  }

  // --------------- 会话消息本地缓存（打开会话秒开，不白屏） ---------------
  const msgCache = {};
  function loadMsgCache(friend) {
    try {
      const raw = localStorage.getItem('chat_msgs_' + friend);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) { msgCache[friend] = arr; return arr; }
      }
    } catch (e) {}
    return [];
  }
  function saveMsgCache(friend) {
    try {
      const arr = msgCache[friend] || [];
      localStorage.setItem('chat_msgs_' + friend, JSON.stringify(arr.slice(-200)));
    } catch (e) {}
  }
  function appendMsgToCache(friend, m) {
    try {
      if (!msgCache[friend]) msgCache[friend] = loadMsgCache(friend);
      msgCache[friend].push(m);
      if (msgCache[friend].length > 300) msgCache[friend] = msgCache[friend].slice(-300);
      saveMsgCache(friend);
    } catch (e) {}
  }

  function openConversation(friend) {
    // 若窗口里已经是这位朋友的聊天（从会话列表返回后再点进来），不清空不重建，只后台拉增量
    const alreadyHere = !!chatWindow && chatWindow.dataset.friend === friend && chatWindow.children.length > 0;

    currentFriend = friend;
    if (chatWindow) chatWindow.dataset.friend = friend;
    unreadMap[friend] = 0;
    updateConversationRedDot(friend);

    if (!currentUser) return;
    // 服务端未读清零（等价于旧 socket 'open-conversation'）
    // 注意：supabase.rpc() 返回的是 thenable（只有 .then 没有 .catch），直接用 .catch 会抛 TypeError 导致聊天窗口打不开
    if (supabase) supabase.rpc('open_conversation', { p_user: currentUser, p_friend: friend }).then(()=>{}, ()=>{});

    const found = friends.find(x => x.friend === friend);
    const remark = (found && found.remark) || '';
    // 上方大标题显示备注（无备注则显示昵称）；下方小字显示原始昵称，避免两行备注重复
    if (chatTitle) chatTitle.textContent = remark || friend;
    if (friendRemarkDisplay) friendRemarkDisplay.textContent = remark ? friend : '';

    if (!alreadyHere) {
      // 切到别的会话：清空窗口，先渲染本地缓存，秒开不白屏
      if (chatWindow) chatWindow.innerHTML = '';
      lastMsgDateKey = null;
      const cached = loadMsgCache(friend);
      cached.forEach(m => addMessageToWindow(m.from_user, m.message, m.ts));
      // 缓存消息批量渲染，不播放淡入动画（此后实时/增量收到的新消息仍有动画）
      chatWindow.querySelectorAll('.msg-row').forEach(r => { r.style.animation = 'none'; });
      if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    chatState.oldestId = null;
    chatState.hasMore = true;
    chatState.loading = true;

    if (!supabase) { chatState.loading = false; return; }
    supabase.rpc('get_messages', { p_user: currentUser, p_friend: friend, p_limit: 200, p_before: null })
      .then(({ data, error }) => {
        const list = error ? [] : (data || []);
        if (!chatWindow || chatWindow.dataset.friend !== friend) return; // 用户已切到别的会话，丢弃这次结果

        const serverMsgs = list.map(m => ({ from_user: m.from_user, message: m.message, type: m.type || 'text', ts: m.ts }));

        // 当前已渲染消息的最大 ts：只追加比它更新的消息，已有 DOM 一律不动，避免清空重建导致闪烁
        let lastTs = -1;
        chatWindow.querySelectorAll('.msg-row').forEach(r => {
          const t = Number(r.dataset.ts);
          if (isFinite(t) && t > lastTs) lastTs = t;
        });

        let appended = false;
        for (const m of list) {
          const mts = Number(m.ts) || 0;
          if (mts > lastTs) {
            addMessageToWindow(m.from_user, m.message, m.ts);
            appended = true;
          }
        }

        // 以服务端数据为准刷新本地缓存
        msgCache[friend] = serverMsgs;
        saveMsgCache(friend);

        if (list.length) chatState.oldestId = list[0].id;
        chatState.hasMore = list.length >= 200;

        if (!list.length && !chatWindow.querySelector('.msg-empty-hint') && !chatWindow.querySelector('.msg-row')) {
          const empty = document.createElement('div');
          empty.className = 'msg-empty-hint';
          empty.textContent = '暂无消息，打个招呼吧~';
          chatWindow.appendChild(empty);
        }
        if (appended) chatWindow.scrollTop = chatWindow.scrollHeight;
      })
      .catch(() => { })
      .finally(() => { chatState.loading = false; });

    showChatPanelFull();
  }

  // --------------- 图片压缩 & 上传（Supabase Storage REST，带进度） ---------------
  function compressImage(file, maxKB = 200) {
    return new Promise((resolve) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = () => resolve(file);
      img.onerror = () => resolve(file);
      reader.onload = (e) => { img.src = e.target.result; };
      img.onload = () => {
        if (file.size / 1024 <= maxKB) { resolve(file); return; }

        const MAX_EDGE = 1600;
        let targetW = img.width;
        let targetH = img.height;
        if (targetW > MAX_EDGE || targetH > MAX_EDGE) {
          const scale = Math.min(MAX_EDGE / targetW, MAX_EDGE / targetH);
          targetW = Math.round(targetW * scale);
          targetH = Math.round(targetH * scale);
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const sizeKB = file.size / 1024;
        const ratio = sizeKB / maxKB;
        let qualities;
        if (ratio < 1.5) qualities = [0.9, 0.8];
        else if (ratio < 3.0) qualities = [0.7, 0.6, 0.5];
        else qualities = [0.5, 0.4, 0.3];

        function compressAt(i, best) {
          if (i >= qualities.length) { resolve(best || file); return; }
          canvas.toBlob((blob) => {
            if (!blob) { resolve(best || file); return; }
            if (blob.size / 1024 <= maxKB) { resolve(blob); return; }
            compressAt(i + 1, blob);
          }, 'image/jpeg', qualities[i]);
        }
        compressAt(0, null);
      };
      reader.readAsDataURL(file);
    });
  }

  // 上传到 Supabase Storage 公共桶 chat-images，返回可公开访问的 URL
  function uploadImage(file, onProgress) {
    return new Promise((resolve) => {
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { resolve(null); return; }
      const ext = (file.type || '').includes('png') ? 'png' : 'jpg';
      const bucket = 'chat-images';
      const path = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + SUPABASE_ANON_KEY);
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-upsert', 'false');
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(`${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`);
        } else {
          console.error('upload failed:', xhr.status, xhr.responseText);
          resolve(null);
        }
      };
      xhr.onerror = () => resolve(null);
      xhr.send(file);
    });
  }

  // --------------- 消息渲染：URL/图片/视频识别 ---------------
  function createMessageContentNode(text) {
    if (!text && text !== '') return document.createTextNode('');

    const frag = document.createDocumentFragment();
    // 同时识别绝对链接和本站 /uploads/ 相对路径（上传的图片/视频）
    const urlRegex = /https?:\/\/[^\s]+|\/uploads\/[^\s]+/g;
    let lastIndex = 0;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      const idx = match.index;
      if (idx > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
      }

      const urlForExt = url.split('#')[0].split('?')[0];
      const isImg = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(urlForExt);
      const isVideo = /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(urlForExt);
      if (isImg) {
        const wrap = document.createElement('div');
        wrap.className = 'inline-img-wrap';
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'image';
        img.className = 'inline-msg-img';
        img.loading = 'lazy';
        img.style.maxWidth = '200px';
        img.style.maxHeight = '200px';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => {
          const modal = document.createElement('div');
          modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
          const large = document.createElement('img');
          large.src = url;
          large.style.cssText = 'max-width:90%;max-height:90%;border-radius:8px;';
          modal.appendChild(large);
          modal.addEventListener('click', () => document.body.removeChild(modal));
          document.body.appendChild(modal);
        });
        wrap.appendChild(img);
        frag.appendChild(wrap);
      } else if (isVideo) {
        const wrap = document.createElement('div');
        wrap.className = 'inline-video-wrap';
        wrap.style.maxWidth = '260px';
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.className = 'inline-msg-video';
        video.style.cssText = 'width:100%;max-height:220px;border-radius:8px;background:#000;';
        wrap.appendChild(video);
        frag.appendChild(wrap);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = url;
        frag.appendChild(a);
      }

      lastIndex = idx + url.length;
    }
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    if (!frag.childNodes.length) return document.createTextNode(text);
    return frag;
  }

  function formatTs(ts) {
    if (ts === null || ts === undefined || ts === '') return '';
    // 数据库 BIGINT 时间戳可能以字符串返回，统一转成数字，避免 new Date("1699...") 解析失败变成 NaN
    const n = typeof ts === 'number' ? ts : Number(ts);
    if (!isFinite(n)) return '';
    const d = new Date(n);
    const now = new Date();
    const pad = n2 => String(n2).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return hm;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth()+1}月${d.getDate()}日 ${hm}`;
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${hm}`;
  }

  // 会话列表的"最后消息时间"：今天显示时分，今天以前显示日期
  function formatConvTime(ts) {
    const n = typeof ts === 'number' ? ts : Number(ts);
    if (!isFinite(n)) return '';
    const d = new Date(n);
    const now = new Date();
    const pad = x => String(x).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth()+1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
  }

  // 构建单条消息行；sending=true 时显示"发送中"加载态
  function buildMessageRow(sender, text, ts, sending = false) {
    const isMe = sender === currentUser;
    const row = document.createElement('div');
    row.className = 'msg-row ' + (isMe ? 'msg-right' : 'msg-left');
    if (sending) row.classList.add('msg-sending');
    if (ts) row.dataset.ts = ts;

    const avWrap = makeAvatarDOM(sender, isMe ? myAvatar : (avatarCache[sender] || ''), 44);

    const col = document.createElement('div');
    col.className = 'msg-col';

    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (isMe ? 'me' : 'you');

    // 复制按钮（hover 气泡时显示）
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = '复制';
    copyBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = bubble.dataset.rawText || text || '';
      navigator.clipboard.writeText(raw).then(() => toast('已复制')).catch(() => toast('复制失败'));
    });

    const content = createMessageContentNode(text || '');
    bubble.appendChild(content);
    bubble.dataset.rawText = text || '';
    col.appendChild(bubble);
    col.appendChild(copyBtn);

    if (ts) {
      const time = document.createElement('div');
      time.className = 'msg-time';
      time.textContent = formatTs(ts);
      col.appendChild(time);
    }

    // 发送中：气泡角落加个小转圈
    if (sending) {
      const spin = document.createElement('div');
      spin.className = 'msg-spinner';
      col.appendChild(spin);
    }

    if (isMe) {
      row.style.justifyContent = 'flex-end';
      row.appendChild(col);
      row.appendChild(avWrap);
    } else {
      row.style.justifyContent = 'flex-start';
      row.appendChild(avWrap);
      row.appendChild(col);
    }
    return row;
  }

  function addMessageToWindow(sender, text, ts, sending = false) {
    if(!chatWindow) return null;
    maybeInsertDateSep(ts);
    const row = buildMessageRow(sender, text, ts, sending);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return row;
  }

  // --------------- 消息日期分组（微信式分隔条） ---------------
  let lastMsgDateKey = null;
  function maybeInsertDateSep(ts) {
    if (ts === null || ts === undefined || ts === '') return;
    const n = typeof ts === 'number' ? ts : Number(ts);
    if (!isFinite(n)) return;
    const d = new Date(n);
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    if (key === lastMsgDateKey) return;
    lastMsgDateKey = key;
    const sep = document.createElement('div');
    sep.className = 'msg-date-sep';
    sep.textContent = dateLabel(n);
    chatWindow.appendChild(sep);
  }
  function dateLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth()+1}月${d.getDate()}日`;
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  }

  async function loadEarlierMessages() {
    if (!currentUser || !currentFriend || !chatState.hasMore || chatState.loading) return;
    if (!chatState.oldestId) { chatState.hasMore = false; return; }
    if (!supabase) return;
    chatState.loading = true;
    try {
      const { data, error } = await supabase.rpc('get_messages', {
        p_user: currentUser, p_friend: currentFriend, p_limit: 100, p_before: chatState.oldestId
      });
      const list = error ? [] : (data || []);
      if (!list.length) { chatState.hasMore = false; return; }
      const prevHeight = chatWindow.scrollHeight;
      const prevScrollTop = chatWindow.scrollTop;
      const frag = document.createDocumentFragment();
      list.forEach(m => frag.appendChild(buildMessageRow(m.from_user, m.message, m.ts)));
      chatWindow.insertBefore(frag, chatWindow.firstChild);
      chatState.oldestId = list[0].id;
      if (list.length < 100) chatState.hasMore = false;
      chatWindow.scrollTop = prevScrollTop + (chatWindow.scrollHeight - prevHeight);
    } catch (e) { }
    finally { chatState.loading = false; }
  }

  // --------------- 发送消息（RPC 写库 + Realtime 广播） ---------------
  async function sendMessage(text, type = 'text') {
    if (!currentFriend) { toast('请选择会话'); return; }
    if (!text) return;
    if (!supabaseReady() || !rtChannel || !rtReady) { toast('连接已断开，消息未发送'); return; }
    const ts = Date.now();
    // 本地先渲染，带"发送中"态，等 RPC 成功后再去掉（等价于旧 ack）
    const row = addMessageToWindow(currentUser, text, ts, true);
    updateConversationPreview(currentFriend, { from_user: currentUser, message: text, type, ts });
    appendMsgToCache(currentFriend, { from_user: currentUser, message: text, type, ts });

    try {
      const { data, error } = await supabase.rpc('send_message', {
        p_from: currentUser, p_to: currentFriend, p_message: text, p_type: type, p_ts: ts
      });
      if (error || !data || !data.success) throw new Error((error && error.message) || '发送失败');

      // 发送成功：清除"发送中"状态（等价于旧 message-sent-ack）
      if (row) {
        row.classList.remove('msg-sending');
        const spin = row.querySelector('.msg-spinner');
        if (spin) spin.remove();
      }
      // 广播给对方的在线端（Supabase 广播不会发回自己；对方离线也能从数据库拉取）
      rtChannel.send({
        type: 'broadcast', event: 'msg',
        payload: { from: currentUser, to: currentFriend, message: text, type, ts }
      });
    } catch (e) {
      // 发送失败回执：标记该条消息失败并提示（等价于旧 message-send-failed）
      if (row) {
        row.classList.remove('msg-sending');
        const spin = row.querySelector('.msg-spinner');
        if (spin) spin.remove();
        row.classList.add('msg-failed');
      }
      toast('消息发送失败', 'error');
    }

    if (type === 'text' && msgInput) msgInput.value = '';
  }

  // --------------- 事件绑定：文本发送 ---------------
  if(btnSendText) btnSendText.addEventListener('click', () => sendMessage(msgInput.value.trim()));
  if(msgInput) msgInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') sendMessage(msgInput.value.trim()); });

  // --------------- 事件绑定：输入区（点击 + 按钮后才出现输入框） ---------------
  const btnMore = document.getElementById('btnMore');
  const composerInner = document.querySelector('.composer-inner');
  if (btnMore && composerInner) btnMore.addEventListener('click', () => {
    const willOpen = !composerInner.classList.contains('open');
    composerInner.classList.toggle('open');
    btnMore.classList.toggle('active');
    if (willOpen && msgInput) setTimeout(() => { try { msgInput.focus(); } catch(e) {} }, 60);
  });

  const btnSendImage = document.getElementById('btnSendImage');
  if (btnSendImage && imgUpload) btnSendImage.addEventListener('click', () => imgUpload.click());

  if(imgUpload) {
    imgUpload.addEventListener('change', async (e) => {
      const fileInput = e.target;
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!currentUser || !currentFriend) { toast('请先选择会话'); fileInput.value = ''; return; }
      if (!supabaseReady() || !rtChannel || !rtReady) { toast('连接已断开'); fileInput.value = ''; return; }

      // 先加一个占位气泡显示上传进度
      const ts = Date.now();
      const placeholder = addMessageToWindow(currentUser, '[上传中 0%]', ts, true);

      const compressed = await compressImage(file);
      const url = await uploadImage(compressed, (pct) => {
        const bubble = placeholder && placeholder.querySelector('.bubble');
        if (bubble) bubble.textContent = `[上传中 ${pct}%]`;
      });

      if (!url) {
        if (placeholder) placeholder.remove();
        toast('上传失败');
        fileInput.value = '';
        return;
      }

      // 替换占位气泡，走与文字相同的发送流程（渲染真实消息 → RPC 写库 → 广播）
      if (placeholder) placeholder.remove();
      await sendMessage(url, 'image');
      fileInput.value = '';
    });
  }

  // --------------- 编辑备注 / 添加好友 / 头像保存 ---------------
  function editRemarkForFriend(f){
    const cur = friends.find(x=>x.friend===f); const curR = cur?cur.remark:'';
    const r = prompt('设置备注（留空则取消）', curR);
    if(r===null) return;
    if(!supabaseReady()) return;
    supabase.rpc('set_remark', { p_owner: currentUser, p_friend: f, p_remark: r })
      .then(({ data }) => { if (data && data.success) { loadFriends(); throttleLoadConversations(); } else toast('设置失败', 'error'); })
      .catch(()=>toast('请求失败', 'error'));
  }

  if(btnAdd) btnAdd.addEventListener('click', ()=> {
    if(!currentUser){ toast('请先在「设置」页登录'); return; }
    const t = newFriendInput.value.trim();
    if(!t){ toast('请输入好友用户名'); return; }
    if(!supabaseReady()) return;
    supabase.rpc('add_friend', { p_user: currentUser, p_friend: t, p_remark: '' })
      .then(({ data, error }) => {
        const res = data || {};
        if (res.success) { newFriendInput.value=''; toast('已添加'); loadFriends(); throttleLoadConversations(); }
        else toast('添加失败: ' + (res.msg || (error ? error.message : '')), 'error');
      })
      .catch(()=>toast('添加好友失败', 'error'));
  });

  if(btnSaveAvatar) btnSaveAvatar.addEventListener('click', ()=> {
    const url = avatarInput.value.trim();
    if(!supabaseReady()) return;
    supabase.rpc('update_profile', { p_username: currentUser, p_avatar: url })
      .then(({ data }) => { if (data && data.success) { myAvatar = url || ''; avatarCache[currentUser] = myAvatar; renderMyAvatar(); loadFriends(); throttleLoadConversations(); toast('头像已保存'); } else toast('保存失败', 'error'); })
      .catch(()=>toast('保存头像失败', 'error'));
  });

  // 输入外链时实时预览头像（未保存不落库）
  if (avatarInput) avatarInput.addEventListener('input', () => {
    if (!meAvatarWrap || !currentUser) return;
    const v = avatarInput.value.trim();
    meAvatarWrap.innerHTML = '';
    meAvatarWrap.appendChild(makeAvatarDOM(currentUser, v || myAvatar, 52));
  });

  const avatarUpload = document.getElementById('avatarUpload');
  const btnUploadAvatar = document.getElementById('btnUploadAvatar');
  if (btnUploadAvatar && avatarUpload) btnUploadAvatar.addEventListener('click', () => avatarUpload.click());
  if (avatarUpload) {
    avatarUpload.addEventListener('change', async (e) => {
      const fileInput = e.target;
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!supabaseReady()) { fileInput.value = ''; return; }
      // 头像上传前自动压缩，避免大图上传慢/占空间
      const compressed = await compressImage(file, 300);
      const url = await uploadImage(compressed);
      if (!url) { toast('头像上传失败', 'error'); fileInput.value = ''; return; }
      avatarInput.value = url;
      try {
        const { data } = await supabase.rpc('update_profile', { p_username: currentUser, p_avatar: url });
        if (data && data.success) {
          myAvatar = url;
          avatarCache[currentUser] = myAvatar;
          renderMyAvatar();
          loadFriends();
          throttleLoadConversations();
          toast('头像已更新');
        } else toast('保存失败', 'error');
      } catch (err) { toast('保存失败', 'error'); }
      fileInput.value = '';
    });
  }

  // --------------- 页面背景图（仅本地保存，不上传） ---------------
  const bgInput = document.getElementById('bgInput');
  const btnChooseBg = document.getElementById('btnChooseBg');
  const bgUpload = document.getElementById('bgUpload');
  const btnSaveBg = document.getElementById('btnSaveBg');
  const btnRemoveBg = document.getElementById('btnRemoveBg');
  const bgStatus = document.getElementById('bgStatus');

  function applyPageBg(url) {
    const has = !!(url && String(url).trim());
    document.body.classList.toggle('has-page-bg', has);
    if (app) {
      app.style.backgroundImage = has ? 'url("' + String(url).replace(/"/g, '%22').replace(/\\/g, '%5C') + '")' : '';
    }
    if (bgStatus) bgStatus.textContent = has ? '已应用主页面背景（仅保存在本机）' : '未设置背景图';
  }
  function savePageBg(url) {
    try {
      if (url && String(url).trim()) localStorage.setItem('chat_page_bg', String(url).trim());
      else localStorage.removeItem('chat_page_bg');
    } catch(e) { toast('保存失败（图片可能过大）', 'error'); return; }
    applyPageBg(url);
  }
  function loadPageBg() {
    let stored = '';
    try { stored = localStorage.getItem('chat_page_bg') || ''; } catch(e) {}
    if (bgInput) bgInput.value = stored;
    applyPageBg(stored);
  }
  function fileToBgDataUrl(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      img.onerror = () => resolve(null);
      reader.onload = (e) => { img.src = e.target.result; };
      img.onload = () => {
        const MAX_EDGE = 1600;
        let w = img.width, h = img.height;
        if (w > MAX_EDGE || h > MAX_EDGE) {
          const s = Math.min(MAX_EDGE / w, MAX_EDGE / h);
          w = Math.round(w * s); h = Math.round(h * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL('image/jpeg', 0.82)); } catch(e) { resolve(null); }
      };
      reader.readAsDataURL(file);
    });
  }
  if (btnChooseBg && bgUpload) btnChooseBg.addEventListener('click', () => bgUpload.click());
  if (bgUpload) bgUpload.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const dataUrl = await fileToBgDataUrl(file);
    if (!dataUrl) { toast('背景图处理失败', 'error'); return; }
    if (bgInput) bgInput.value = dataUrl;
    savePageBg(dataUrl);
    toast('背景图已应用', 'success');
  });
  if (btnSaveBg) btnSaveBg.addEventListener('click', () => {
    const v = bgInput ? bgInput.value.trim() : '';
    if (!v) { toast('请先粘贴外链或选择本地图片', 'error'); return; }
    savePageBg(v);
    toast('背景图已应用', 'success');
  });
  if (btnRemoveBg) btnRemoveBg.addEventListener('click', () => {
    if (bgInput) bgInput.value = '';
    savePageBg('');
    toast('已移除背景图');
  });
  loadPageBg();

  // 通知设置：显示当前权限状态，提供手动开启入口
  const btnNotifyToggle = document.getElementById('btnNotifyToggle');
  const notifyStatus = document.getElementById('notifyStatus');

  function refreshNotifyStatus() {
    if (!notifyStatus || !btnNotifyToggle) return;
    if (typeof Notification === 'undefined') {
      notifyStatus.textContent = '当前浏览器不支持通知功能';
      notifyStatus.style.color = '';
      btnNotifyToggle.style.display = 'none';
      return;
    }
    const p = Notification.permission;
    if (p === 'granted') {
      notifyStatus.textContent = '已开启，收到新消息会弹系统通知';
      notifyStatus.style.color = '#22c55e';
      btnNotifyToggle.style.display = 'none';
    } else if (p === 'denied') {
      notifyStatus.textContent = '浏览器已拦截通知。请点地址栏左边的锁/设置图标，把"通知"改成允许，再刷新页面';
      notifyStatus.style.color = '#ef4444';
      btnNotifyToggle.style.display = 'none';
    } else {
      notifyStatus.textContent = '未开启。开启后即使切到别的标签页也能收到提醒';
      notifyStatus.style.color = '';
      btnNotifyToggle.style.display = '';
    }
  }

  if (btnNotifyToggle) {
    btnNotifyToggle.addEventListener('click', async () => {
      const p = await Notification.requestPermission();
      refreshNotifyStatus();
      if (p === 'granted') toast('通知已开启', 'success');
      else if (p === 'denied') toast('浏览器拒绝了，需手动去站点设置里改', 'error');
    });
  }
  refreshNotifyStatus();

  // 首次进入网页：弹窗提示开启消息通知（只提示一次）
  function maybePromptNotify() {
    if (typeof Notification === 'undefined') return;
    const p = Notification.permission;
    if (p === 'granted' || p === 'denied') return;
    let prompted = false;
    try { prompted = !!localStorage.getItem('chat_notify_prompted'); } catch(e) {}
    if (prompted) return;
    const promptEl = document.getElementById('notifyPrompt');
    if (!promptEl) return;
    const yesBtn = document.getElementById('btnNotifyYes');
    const noBtn = document.getElementById('btnNotifyNo');
    if (yesBtn) yesBtn.onclick = async () => {
      promptEl.style.display = 'none';
      try { localStorage.setItem('chat_notify_prompted', '1'); } catch(e) {}
      try {
        const res = await Notification.requestPermission();
        refreshNotifyStatus();
        if (res === 'granted') toast('通知已开启', 'success');
        else if (res === 'denied') toast('浏览器拒绝了通知请求', 'error');
      } catch(e) {}
    };
    if (noBtn) noBtn.onclick = () => {
      promptEl.style.display = 'none';
      try { localStorage.setItem('chat_notify_prompted', '1'); } catch(e) {}
    };
    setTimeout(() => { promptEl.style.display = 'flex'; }, 800);
  }

  if(btnRegister) btnRegister.addEventListener('click', async () => {
    const u = document.getElementById('li-username').value.trim();
    const p = document.getElementById('li-password').value;
    const c = document.getElementById('li-code').value.trim();
    if(!u||!p){ toast('用户名/密码不能为空'); return; }
    if(!c){ toast('请填写邀请码'); return; }
    if(!supabaseReady()) return;
    try {
      const { data, error } = await supabase.rpc('register', { p_username: u, p_password: p, p_code: c });
      const res = data || {};
      toast(res.success ? '注册成功，请登录' : ('注册失败: ' + (res.msg || (error ? error.message : ''))), res.success ? 'success' : 'error');
    } catch(e) { toast('注册请求失败', 'error'); }
  });

  if(btnLogin) btnLogin.addEventListener('click', async () => {
    const u = document.getElementById('li-username').value.trim();
    const p = document.getElementById('li-password').value;
    if(!u||!p){ toast('用户名/密码不能为空'); return; }
    if(!supabaseReady()) return;
    try {
      const { data, error } = await supabase.rpc('login', { p_username: u, p_password: p });
      const res = data || {};
      if(res.success && res.user){
        currentUser = res.user.username;
        myAvatar = res.user.avatar || '';
        localStorage.setItem('chat_currentUser', currentUser);
        localStorage.setItem('chat_myAvatar', myAvatar || '');
        avatarCache[currentUser] = myAvatar;
        document.getElementById('meName').textContent = currentUser;
        avatarInput.value = myAvatar;
        renderMyAvatar();
        // 登录后先清空本地未读缓存，等服务端 get_unread_counts 回来再填正确值
        unreadMap = {};
        localStorage.removeItem('chat_unreadMap');
        setupRealtime();
        loadUnreadCounts();
        // 注意：不在登录后自动请求通知权限——浏览器只认"用户主动点击"触发的请求，
        // 自动请求会被忽略甚至被记成拒绝，导致之后点"开启通知"不再弹窗。改为用户在按钮上主动开启。
        await loadFriends();
        throttleLoadConversations();
        meNote.value = DEV_NOTE;
        showApp();
        document.getElementById('li-password').value = '';
        toast('欢迎回来，' + currentUser, 'success');
      } else toast('登录失败: ' + (res.msg || (error ? error.message : '')), 'error');
    } catch(e) { toast('登录请求失败', 'error'); }
  });

  // Auto-login
  (function tryAutoLogin(){
    const stored = localStorage.getItem('chat_currentUser');
    const storedAvatar = localStorage.getItem('chat_myAvatar') || '';
    if(stored && supabase){
      currentUser = stored;
      myAvatar = storedAvatar;
      avatarCache[currentUser] = myAvatar;
      document.getElementById('meName').textContent = currentUser;
      avatarInput.value = myAvatar;
      renderMyAvatar();
      unreadMap = {};
      localStorage.removeItem('chat_unreadMap');
      setupRealtime();
      loadUnreadCounts();
      // 与登录一致：不自动请求通知权限，避免浏览器忽略/误拒后按钮失效
      loadFriends().then(()=>{ throttleLoadConversations(); });
      meNote.value = DEV_NOTE;
      showApp();
      document.getElementById('li-password').value = '';
    } else {
      showLogin();
    }
  })();

  // 首次进入网页时提示开启消息通知（浏览器要求由用户点击触发，用弹窗按钮）
  maybePromptNotify();

  // Logout
  if(btnLogout) btnLogout.addEventListener('click', ()=> {
    if(currentUser) localStorage.setItem('chat_lastUser', currentUser);
    localStorage.removeItem('chat_currentUser');
    localStorage.removeItem('chat_myAvatar');
    try{
      if (presenceChannel) { presenceChannel.untrack(); supabase.removeChannel(presenceChannel); }
      if (rtChannel) supabase.removeChannel(rtChannel);
    }catch(e){}
    presenceChannel = null; rtChannel = null; rtReady = false;
    location.reload();
  });

  window.currentUser = () => currentUser;
  window.currentFriend = () => currentFriend;
  window.supabaseClient = () => supabase;
})();
