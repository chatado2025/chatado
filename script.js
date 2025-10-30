// script.js - Chat completo com Ably, WebRTC, envio de arquivos, criação de grupos e mensagens de voz
// Mantive a estrutura do seu código original, finalizei partes faltantes,
// adicionei tratamento robusto para getUserMedia / WebRTC e gravação de áudio.

document.addEventListener('DOMContentLoaded', function () {

  // ----------------- Config / Variáveis globais -----------------
  const ABLY_KEY = 'zfqwdA.QY0KxQ:_RQcTI6NCeRMNnLLyC8Ebb6Lg50xnDlcwvRv4wQ3H5o';
  var username = '';
  var currentChatUser = null; // either username (string) for private chats or groupId (string) for groups
  var currentChatIsGroup = false;
  var typingTimeout = null;
  var usersOnline = [];
  var unreadCounts = {}; // keys: username or groupId
  var chatHistory = {}; // keys: username or groupId -> array of messages
  var privateChannels = {}; // keys: channelName -> ably channel
  var seenMessageIds = new Set();
  var groups = {}; // groupId -> { id, name, members }

  // WebRTC
  var peerConnection = null;
  var localStream = null;
  var remoteStream = null;
  var currentCallUser = null;

  // Ably instance (populated on init)
  var ably = null;

  // ----------------- DOM refs -----------------
  var loginScreen = document.getElementById('loginScreen');
  var chatScreen = document.getElementById('chatScreen');
  var enterChatBtn = document.getElementById('enterChat');
  var sendMessageBtn = document.getElementById('sendMessage');
  var messagesDiv = document.getElementById('messages');
  var messageInput = document.getElementById('messageInput');
  var contactsUl = document.getElementById('contacts');
  var chatTitle = document.getElementById('chatTitle');
  var contactsList = document.getElementById('contactsList');
  var menuHamburger = document.querySelector('.menu-hamburger');
  var inputArea = document.getElementById('inputArea');
  var typingIndicator = document.getElementById('typingIndicator');

  // file attach elements (may be created dynamically)
  var attachFileBtn = document.getElementById('attachFileBtn');
  var fileInput = document.getElementById('fileInput');

  // Voice recording controls
  var micBtn = null;
  var mediaRecorder = null;
  var recordedChunks = [];
  var isRecording = false;

  // ensure attachFileBtn and fileInput exist
  if (!attachFileBtn && inputArea) {
    attachFileBtn = document.createElement('button');
    attachFileBtn.id = 'attachFileBtn';
    attachFileBtn.title = 'Anexar arquivo';
    attachFileBtn.innerHTML = '<i class="fa-solid fa-paperclip"></i>';
    if (inputArea && sendMessageBtn) inputArea.insertBefore(attachFileBtn, sendMessageBtn);
  }
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'fileInput';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
  }

  // Create microphone button (always visible next to send)
  if (inputArea && !document.getElementById('micBtn')) {
    micBtn = document.createElement('button');
    micBtn.id = 'micBtn';
    micBtn.title = 'Gravar mensagem de voz';
    micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    micBtn.style.marginRight = '8px';
    micBtn.style.border = 'none';
    micBtn.style.background = 'transparent';
    micBtn.style.cursor = 'pointer';
    micBtn.style.fontSize = '18px';
    micBtn.style.display = 'inline-flex';
    micBtn.style.alignItems = 'center';
    micBtn.style.justifyContent = 'center';
    // insert before sendMessageBtn
    if (sendMessageBtn) inputArea.insertBefore(micBtn, sendMessageBtn);
  } else {
    micBtn = document.getElementById('micBtn');
  }

  // close-chat button
  var closeChatBtn = document.createElement('button');
  closeChatBtn.className = 'close-chat-btn';
  closeChatBtn.innerHTML = '<i class="fa-solid fa-square-xmark" style="color:white"></i>';
  closeChatBtn.style.display = 'none';
  var chatHeader = document.querySelector('.chat-header');
  if (chatHeader) chatHeader.appendChild(closeChatBtn);

  // Create group button (for creating groups)
  var createGroupBtn = document.createElement('button');
  createGroupBtn.id = 'createGroupBtn';
  createGroupBtn.style.margin = '8px';
  createGroupBtn.style.padding = '6px 8px';
  createGroupBtn.style.borderRadius = '6px';
  createGroupBtn.style.border = 'none';
  createGroupBtn.style.cursor = 'pointer';
  createGroupBtn.style.background = 'transparent';
  createGroupBtn.style.color = 'inherit';
  createGroupBtn.innerHTML = '<i class="fa-solid fa-users"></i> Criar Grupo';
  try {
    var contactsHeader = contactsList ? contactsList.querySelector('h3') : null;
    if (contactsHeader && contactsHeader.parentNode) contactsHeader.parentNode.insertBefore(createGroupBtn, contactsHeader.nextSibling);
  } catch (e) { /* ignore */ }

  // Group creation modal (rename to avoid collision with members modal)
  var groupCreateModal = document.createElement('div');
  groupCreateModal.className = 'video-modal';
  groupCreateModal.style.display = 'none';
  groupCreateModal.innerHTML = '<div class="video-container" style="background:#111;padding:18px;border-radius:12px;text-align:left;max-width:480px;width:90%;">' +
    '<h3 style="color:#fff;margin-bottom:8px;">Criar grupo</h3>' +
    '<label style="color:#fff;display:block;margin-bottom:6px;">Nome do grupo</label>' +
    '<input id="groupNameInput" placeholder="Ex: Amigos" style="width:100%;padding:8px;border-radius:6px;border:none;margin-bottom:10px;">' +
    '<label style="color:#fff;display:block;margin-bottom:6px;">Selecione contatos</label>' +
    '<div id="groupContactsList" style="max-height:200px;overflow:auto;padding:6px;background:#0f0f0f;border-radius:6px;margin-bottom:10px;"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
    '<button id="cancelCreateGroup" style="padding:8px 12px;border-radius:6px;border:none;cursor:pointer;background:#e74c3c;color:#fff;">Cancelar</button>' +
    '<button id="confirmCreateGroup" style="padding:8px 12px;border-radius:6px;border:none;cursor:pointer;background:#00b894;color:#fff;">Criar</button>' +
    '</div></div>';
  document.body.appendChild(groupCreateModal);
  var groupNameInput = groupCreateModal.querySelector('#groupNameInput');
  var groupContactsList = groupCreateModal.querySelector('#groupContactsList');
  var cancelCreateGroup = groupCreateModal.querySelector('#cancelCreateGroup');
  var confirmCreateGroup = groupCreateModal.querySelector('#confirmCreateGroup');

  // Incoming-call modal
  var callModal = document.createElement('div');
  callModal.className = 'video-modal';
  callModal.style.display = 'none';
  callModal.innerHTML = '<div class="video-container" style="background:#111;padding:18px;border-radius:12px;text-align:center;">' +
    '<p id="callerLabel" style="color:#fff;font-size:16px;margin-bottom:12px;"></p>' +
    '<div style="display:flex;gap:12px;justify-content:center;">' +
    '<button id="acceptCallBtn" style="padding:10px 14px;border-radius:10px;background:#2ecc71;border:none;color:#fff;cursor:pointer">Atender</button>' +
    '<button id="declineCallBtn" style="padding:10px 14px;border-radius:10px;background:#e74c3c;border:none;color:#fff;cursor:pointer">Recusar</button>' +
    '</div></div>';
  document.body.appendChild(callModal);
  var callerLabel = callModal.querySelector('#callerLabel');
  var acceptCallBtn = callModal.querySelector('#acceptCallBtn');
  var declineCallBtn = callModal.querySelector('#declineCallBtn');

  // Video modal for active call
  var videoModal = document.createElement('div');
  videoModal.className = 'video-modal';
  videoModal.style.display = 'none';
  videoModal.innerHTML = '<div class="video-container" style="display:flex;flex-direction:column;align-items:center;gap:10px;">' +
    '<video id="remoteVideo" autoplay playsinline style="width:420px;max-width:90%;border-radius:12px;background:#000"></video>' +
    '<video id="localVideoMini" autoplay muted playsinline style="width:150px;height:110px;border-radius:8px;background:#000;position:relative"></video>' +
    '<div class="call-controls" style="display:flex;gap:10px;">' +
    '<button id="endCallBtn" class="end-call">Encerrar</button>' +
    '<button id="muteAudioBtn" class="end-call">Mudo</button>' +
    '<button id="muteVideoBtn" class="end-call">Vídeo Off</button>' +
    '</div></div>';
  document.body.appendChild(videoModal);
  var remoteVideo = videoModal.querySelector('#remoteVideo');
  var localVideoMini = videoModal.querySelector('#localVideoMini');
  var endCallBtn = videoModal.querySelector('#endCallBtn');
  var muteAudioBtn = videoModal.querySelector('#muteAudioBtn');
  var muteVideoBtn = videoModal.querySelector('#muteVideoBtn');

  // ----------------- Modal de participantes de grupo -----------------
  var groupMembersModal = document.createElement('div');
  groupMembersModal.id = 'groupMembersModal';
  groupMembersModal.className = 'video-modal';
  groupMembersModal.style.display = 'none';
  groupMembersModal.innerHTML = `
    <div class="video-container" style="background:#fff;padding:16px;border-radius:12px;max-width:360px;width:90%;text-align:left;">
      <h3 id="groupMembersTitle" style="color:#4b6cb7;margin-bottom:8px;"></h3>
      <ul id="groupMembersList" style="list-style:none;padding:0;margin:0 0 12px 0;max-height:260px;overflow:auto;"></ul>
      <div style="text-align:right;">
        <button id="closeGroupMembersModal" style="background:#4b6cb7;color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;">Fechar</button>
      </div>
    </div>
  `;
  document.body.appendChild(groupMembersModal);
  var groupMembersTitle = groupMembersModal.querySelector('#groupMembersTitle');
  var groupMembersList = groupMembersModal.querySelector('#groupMembersList');
  var closeGroupMembersModal = groupMembersModal.querySelector('#closeGroupMembersModal');

  closeGroupMembersModal && closeGroupMembersModal.addEventListener('click', function () {
    groupMembersModal.style.display = 'none';
  });

  function openGroupMembersModal(groupId) {
    var g = groups[groupId];
    var name = (g && g.name) ? g.name : groupId;
    var members = (g && g.members) ? g.members : [];
    groupMembersTitle.textContent = 'Participantes - ' + name;
    groupMembersList.innerHTML = '';
    if (!members || members.length === 0) {
      var li = document.createElement('li');
      li.textContent = 'Nenhum participante.';
      li.style.color = '#666';
      li.style.padding = '6px 0';
      groupMembersList.appendChild(li);
    } else {
      members.forEach(function (m) {
        var li = document.createElement('li');
        li.style.padding = '6px 0';
        li.style.borderBottom = '1px solid #eee';
        li.textContent = '👤 ' + m;
        groupMembersList.appendChild(li);
      });
    }
    groupMembersModal.style.display = 'flex';
  }

  // ----------------- Utilitários -----------------
  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function genMessageId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  function genGroupId() {
    return 'group-' + genMessageId();
  }

  function showTyping(user) {
    if (!typingIndicator) return;
    typingIndicator.textContent = user + ' está digitando...';
    typingIndicator.style.opacity = '0';
    typingIndicator.style.transition = 'opacity 0.25s ease';
    requestAnimationFrame(() => { typingIndicator.style.opacity = '1'; });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      typingIndicator.style.opacity = '0';
      setTimeout(() => { typingIndicator.textContent = ''; }, 250);
    }, 1200);
  }

  // ----------------- Contatos e Grupos (render com botão ver participantes) -----------------
  function renderContacts() {
    if (!contactsUl) return;
    contactsUl.innerHTML = '';

    // Groups first
    Object.keys(groups).forEach(function (gid) {
      var g = groups[gid];
      var li = document.createElement('li');
      li.dataset.user = gid;
      li.className = 'contact-item';
      li.style.position = 'relative';
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.padding = '8px';

      var leftWrap = document.createElement('div');
      leftWrap.style.display = 'flex';
      leftWrap.style.alignItems = 'center';
      leftWrap.style.gap = '8px';

      var status = document.createElement('span');
      status.className = 'status-dot';
      status.style.background = '#FF4500';
      leftWrap.appendChild(status);

      var nameSpan = document.createElement('span');
      nameSpan.textContent = g.name + ' (' + (g.members ? g.members.length : 0) + ')';
      leftWrap.appendChild(nameSpan);
      li.appendChild(leftWrap);

      // Right side: badge + view members
      var rightWrap = document.createElement('div');
      rightWrap.style.display = 'flex';
      rightWrap.style.alignItems = 'center';
      rightWrap.style.gap = '8px';

      var count = unreadCounts[gid] || 0;
      var badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
      rightWrap.appendChild(badge);

      // View members button
      var viewMembersBtn = document.createElement('button');
      viewMembersBtn.className = 'call-btn';
      viewMembersBtn.title = 'Ver participantes';
      viewMembersBtn.innerHTML = '<i class="fa-solid fa-user-group"></i>';
      viewMembersBtn.style.background = 'none';
      viewMembersBtn.style.border = 'none';
      viewMembersBtn.style.cursor = 'pointer';
      viewMembersBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openGroupMembersModal(gid);
      });
      rightWrap.appendChild(viewMembersBtn);

      li.appendChild(rightWrap);

      li.addEventListener('click', function () {
        openChat(gid, true);
        unreadCounts[gid] = 0;
        renderContacts();
        if (window.innerWidth <= 900 && contactsList) contactsList.classList.remove('open');
      });

      contactsUl.appendChild(li);
    });

    // Individual users
    var all = Array.from(new Set(usersOnline.concat(Object.keys(chatHistory).filter(k => !k.startsWith('group-')))));
    all.forEach(function (user) {
      if (!user || user === username) return;
      var li = document.createElement('li');
      li.dataset.user = user;
      li.className = 'contact-item';
      li.style.position = 'relative';
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.padding = '8px';

      var leftWrap = document.createElement('div');
      leftWrap.style.display = 'flex';
      leftWrap.style.alignItems = 'center';
      leftWrap.style.gap = '8px';

      var status = document.createElement('span');
      status.className = 'status-dot';
      leftWrap.appendChild(status);

      var nameSpan = document.createElement('span');
      nameSpan.textContent = user;
      leftWrap.appendChild(nameSpan);
      li.appendChild(leftWrap);

      // Right side: call button + badge
      var rightWrap = document.createElement('div');
      rightWrap.style.display = 'flex';
      rightWrap.style.alignItems = 'center';
      rightWrap.style.gap = '8px';

      // call button (video icon)
      var callBtn = document.createElement('button');
      callBtn.className = 'call-btn';
      callBtn.title = 'Iniciar vídeo chamada';
      callBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
      callBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        startVideoCall(user);
      });
      rightWrap.appendChild(callBtn);

      var count = unreadCounts[user] || 0;
      var badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
      rightWrap.appendChild(badge);

      li.appendChild(rightWrap);

      li.addEventListener('click', function () {
        openChat(user, false);
        unreadCounts[user] = 0;
        renderContacts();
        if (window.innerWidth <= 900 && contactsList) contactsList.classList.remove('open');
      });

      contactsUl.appendChild(li);
    });
  }

  // ----------------- Chat UI -----------------
  function openChat(id, isGroup) {
    currentChatUser = id;
    currentChatIsGroup = !!isGroup;
    if (chatTitle) {
      if (currentChatIsGroup) chatTitle.textContent = 'Grupo: ' + (groups[id] ? groups[id].name : id);
      else chatTitle.textContent = 'Chat com ' + id;
    }
    if (messagesDiv) messagesDiv.innerHTML = '';
    if (inputArea) inputArea.style.display = 'flex';
    if (closeChatBtn) closeChatBtn.style.display = 'flex';

    var history = chatHistory[id] || [];
    history.forEach(function (m) {
      addMessageToDom(m.sender, m.text || ('Arquivo: ' + (m.name || '')), m.time, false, m.file, m.type, m.duration);
    });

    // ensure channel subscription for this chat/group
    setupPrivateChannel(id);
  }

  function addMessageToDom(sender, text, time, highlight, fileData, type, duration) {
    if (!messagesDiv) return;
    var div = document.createElement('div');
    div.className = 'message ' + (sender === username ? 'own' : 'other');
    var inner = '<strong>' + escapeHtml(sender) + ':</strong> ' + (text ? escapeHtml(text) : '');
    if (type === 'audio' && fileData && fileData.startsWith('data:audio')) {
      inner += '<br><div style="margin-top:6px;"><audio controls src="' + fileData + '"></audio>';
      if (duration) inner += '<div class="time" style="font-size:11px;color:#555;margin-top:6px;">' + escapeHtml(duration) + '</div>';
      inner += '</div>';
    } else if (fileData) {
      if (fileData.startsWith('data:image')) inner += '<br><img src="' + fileData + '" style="max-width:200px;border-radius:12px;margin-top:6px;">';
      else inner += '<br><a href="' + fileData + '" download target="_blank">' + escapeHtml(text || 'Arquivo') + '</a>';
    }

    div.innerHTML = inner;
    var timeDiv = document.createElement('div');
    timeDiv.className = 'time';
    timeDiv.textContent = time || '';
    div.appendChild(timeDiv);
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    if (highlight && sender !== username) {
      try { new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg').play(); } catch (e) { }
    }
  }

  function sendMessage(channel) {
    if (!currentChatUser || !messageInput) return;
    var text = messageInput.value.trim(); if (!text) return;
    var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var id = genMessageId();
    chatHistory[currentChatUser] = chatHistory[currentChatUser] || [];
    chatHistory[currentChatUser].push({ id: id, sender: username, text: text, time: time });
    if (chatHistory[currentChatUser].length > 200) chatHistory[currentChatUser].shift();
    addMessageToDom(username, text, time, false);
    seenMessageIds.add(id);

    // publish either to private or group channel
    try {
      if (currentChatIsGroup) {
        var chName = 'group:' + currentChatUser;
        var ch = ensurePrivateChannelWithUser(chName);
        if (ch) ch.publish('message', { id: id, username: username, text: text, time: time, groupId: currentChatUser });
      } else {
        var ch = ensurePrivateChannelWithUser(currentChatUser);
        if (ch) ch.publish('message', { id: id, username: username, text: text, time: time });
      }
    } catch (e) { console.warn('publish failed', e); }

    // also send typing event as before
    try {
      if (!currentChatIsGroup && channel) channel.publish('typing', { username: username });
      if (currentChatIsGroup) {
        var groupCh = ensurePrivateChannelWithUser('group:' + currentChatUser);
        if (groupCh) groupCh.publish('typing', { username: username, groupId: currentChatUser });
      }
    } catch (e) { /* ignore */ }

    messageInput.value = '';
  }

  // ----------------- Arquivos -----------------
  function setupFileUpload() {
    if (!attachFileBtn || !fileInput) return;
    attachFileBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (!fileInput.files || fileInput.files.length === 0 || !currentChatUser) return;
      var file = fileInput.files[0];
      var reader = new FileReader();
      reader.onload = function (e) {
        var dataUrl = e.target.result;
        var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var id = genMessageId();
        chatHistory[currentChatUser] = chatHistory[currentChatUser] || [];
        chatHistory[currentChatUser].push({ id: id, sender: username, file: dataUrl, name: file.name, time: time });
        if (chatHistory[currentChatUser].length > 200) chatHistory[currentChatUser].shift();
        addMessageToDom(username, 'Arquivo: ' + file.name, time, false, dataUrl);

        // publish file to correct channel
        try {
          if (currentChatIsGroup) {
            var ch = ensurePrivateChannelWithUser('group:' + currentChatUser);
            if (ch) ch.publish('message', { id: id, username: username, file: dataUrl, name: file.name, time: time, groupId: currentChatUser });
          } else {
            var ch = ensurePrivateChannelWithUser(currentChatUser);
            if (ch) ch.publish('message', { id: id, username: username, file: dataUrl, name: file.name, time: time });
          }
        } catch (e) { console.warn('publish file failed', e); }
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });
  }

  // ----------------- Ably -----------------
  function initAbly() {
    try { ably = new Ably.Realtime({ key: ABLY_KEY, clientId: username }); } catch (e) { alert('Erro inicializando Ably'); return; }
    var presenceChannel = ably.channels.get('presence');
    // enter presence
    try { presenceChannel.presence.enter({ username: username }); } catch (e) { /* ignore */ }

    // listen for existing members
    try {
      presenceChannel.presence.get(function (err, members) {
        if (!err && members && members.length) {
          members.forEach(function (m) {
            var who = (m.data && m.data.username) || m.clientId;
            if (who && who !== username && usersOnline.indexOf(who) === -1) usersOnline.push(who);
          });
          renderContacts();
        }
      });
    } catch (e) { /* ignore */ }

    // subscribe for presence updates
    try {
      presenceChannel.presence.subscribe('enter', function (member) {
        var who = (member.data && member.data.username) || member.clientId;
        if (!who || who === username) return;
        if (usersOnline.indexOf(who) === -1) { usersOnline.push(who); renderContacts(); }
      });
      presenceChannel.presence.subscribe('leave', function (member) {
        var who = (member.data && member.data.username) || member.clientId;
        if (!who) return;
        var idx = usersOnline.indexOf(who);
        if (idx !== -1) { usersOnline.splice(idx, 1); renderContacts(); }
      });
    } catch (e) { /* ignore */ }

    ably.connection.on('statechange', function (stateChange) {
      console.log('Ably state:', stateChange.current);
    });

    // subscribe to groups channel
    var groupsChannel = ably.channels.get('groups');
    try {
      groupsChannel.subscribe('group-created', function (msg) {
        var g = msg.data || {};
        if (!g.id || !g.members) return;
        if (g.members.indexOf(username) !== -1) {
          groups[g.id] = g;
          chatHistory[g.id] = chatHistory[g.id] || [];
          ensurePrivateChannelWithUser('group:' + g.id);
          renderContacts();
        }
      });
    } catch (e) { /* ignore */ }

    // request groups list (naive peer-to-peer approach)
    try { groupsChannel.publish('query-groups', { who: username }); } catch (e) { }

    try {
      groupsChannel.subscribe('groups-list', function (msg) {
        var list = msg.data && msg.data.groups;
        if (Array.isArray(list)) {
          list.forEach(function (g) {
            if (g.members && g.members.indexOf(username) !== -1) {
              groups[g.id] = g;
              chatHistory[g.id] = chatHistory[g.id] || [];
              ensurePrivateChannelWithUser('group:' + g.id);
            }
          });
          renderContacts();
        }
      });
    } catch (e) { /* ignore */ }

    // respond to queries about groups (if you know any)
    try {
      groupsChannel.subscribe('query-groups', function (msg) {
        var who = msg.data && msg.data.who;
        if (!who) return;
        var known = Object.keys(groups).map(function (k) { return groups[k]; }).filter(function (g) {
          return g && g.members && g.members.indexOf(who) !== -1;
        });
        if (known.length > 0) {
          try { groupsChannel.publish('groups-list', { to: who, groups: known }); } catch (e) { }
        }
      });
    } catch (e) { /* ignore */ }

    // ensure file upload btn works
    setupFileUpload();
  }

  function ensurePrivateChannelWithUser(userOrChannelKey) {
    if (!ably) return null;
    var key = userOrChannelKey;
    var channelName = null;
    if (typeof key === 'string' && key.indexOf('group:') === 0) {
      channelName = key;
    } else {
      if (typeof key === 'string' && key.indexOf('chat-') === 0) {
        channelName = key;
      } else {
        channelName = 'chat-' + [username, key].sort().join('-');
      }
    }
    if (!privateChannels[channelName]) {
      privateChannels[channelName] = ably.channels.get(channelName);
      var ch = privateChannels[channelName];
      try { ch.subscribe('message', function (msg) { handleIncomingMessage(msg.data, channelName); }); } catch (e) { }
      try { ch.subscribe('typing', function (msg) { handleIncomingTyping(msg.data, channelName); }); } catch (e) { }
      try { ch.subscribe('call', function (msg) { handleCallSignal(msg.data, ch); }); } catch (e) { }
      try { ch.subscribe('audio', function (msg) { /* in case separate audio events used in future */ }); } catch (e) { }
      try { ch.presence.enter({ username: username }); } catch (e) { /* ignore */ }
    }
    return privateChannels[channelName];
  }

  function handleIncomingMessage(data, channelName) {
    if (!data || !data.username) return;
    var isGroupMsg = !!data.groupId;
    var chatKey = isGroupMsg ? data.groupId : data.username;
    if (!chatHistory[chatKey]) chatHistory[chatKey] = [];
    if (data.id && seenMessageIds.has(data.id)) return;
    if (data.id) seenMessageIds.add(data.id);

    // Normalize message object stored in history: include type and possible file/audio
    var msgObj = { id: data.id, sender: data.username, text: data.text, file: data.file, name: data.name, time: data.time, type: data.type, duration: data.duration };
    chatHistory[chatKey].push(msgObj);
    if (chatHistory[chatKey].length > 200) chatHistory[chatKey].shift();

    if (currentChatUser === chatKey) {
      addMessageToDom(data.username, data.text || ('Arquivo: ' + (data.name || '')), data.time, true, data.file, data.type, data.duration);
    } else {
      unreadCounts[chatKey] = (unreadCounts[chatKey] || 0) + 1;
      renderContacts();
      try { new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg').play(); } catch (e) { }
    }
  }

  function handleIncomingTyping(d, channelName) {
    if (!d) return;
    if (d.groupId) {
      if (currentChatUser === d.groupId && currentChatIsGroup && d.username !== username) showTyping(d.username);
    } else {
      if (currentChatUser === d.username && !currentChatIsGroup && d.username !== username) showTyping(d.username);
    }
  }

  function setupPrivateChannel(userOrChannelKey) {
    return ensurePrivateChannelWithUser(userOrChannelKey);
  }

  // ----------------- Grupo: criação UI e lógica -----------------
  createGroupBtn && createGroupBtn.addEventListener('click', function () {
    groupContactsList.innerHTML = '';
    var available = Array.from(new Set(usersOnline)).filter(function (u) { return u && u !== username; });
    if (available.length === 0) {
      groupContactsList.innerHTML = '<div style="color:#ccc">Nenhum contato disponível</div>';
    } else {
      available.forEach(function (u) {
        var line = document.createElement('div');
        line.style.display = 'flex';
        line.style.alignItems = 'center';
        line.style.justifyContent = 'space-between';
        line.style.padding = '6px';
        line.style.borderBottom = '1px solid #1a1a1a';
        var left = document.createElement('div');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '8px';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.user = u;
        cb.style.marginRight = '8px';
        var lbl = document.createElement('span');
        lbl.style.color = '#fff';
        lbl.textContent = u;
        left.appendChild(cb);
        left.appendChild(lbl);
        line.appendChild(left);
        groupContactsList.appendChild(line);
      });
    }
    groupNameInput.value = '';
    groupCreateModal.style.display = 'flex';
  });

  cancelCreateGroup && cancelCreateGroup.addEventListener('click', function () {
    groupCreateModal.style.display = 'none';
  });

  confirmCreateGroup && confirmCreateGroup.addEventListener('click', function () {
    var name = (groupNameInput.value || '').trim();
    if (!name) { alert('Digite um nome para o grupo'); return; }
    var checked = Array.from(groupContactsList.querySelectorAll('input[type=checkbox]')).filter(function (c) { return c.checked; });
    if (checked.length === 0) { alert('Selecione ao menos um contato'); return; }
    var members = checked.map(function (c) { return c.dataset.user; });
    if (members.indexOf(username) === -1) members.push(username);

    var id = genGroupId();
    var g = { id: id, name: name, members: members };
    groups[id] = g;
    chatHistory[id] = chatHistory[id] || [];

    var groupsChannel = ably ? ably.channels.get('groups') : null;
    try { if (groupsChannel) groupsChannel.publish('group-created', g); } catch (e) { /* ignore */ }

    ensurePrivateChannelWithUser('group:' + id);
    renderContacts();
    groupCreateModal.style.display = 'none';
    openChat(id, true);
  });

  // ----------------- VideoCall / WebRTC -----------------
  function createPeerConnection(channel) {
    var pc = new RTCPeerConnection();

    pc.onicecandidate = function (e) {
      if (e.candidate) {
        try { channel.publish('call', { type: 'ice', candidate: e.candidate, from: username, to: currentCallUser }); } catch (err) { }
      }
    };

    pc.ontrack = function (e) {
      remoteStream = e.streams[0];
      if (remoteVideo) remoteVideo.srcObject = remoteStream;
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // cleanup
      }
    };

    return pc;
  }

  async function startVideoCall(targetUser) {
    // targetUser for private only (no group video here)
    if (!targetUser) return;
    // ensure channel exists
    var ch = ensurePrivateChannelWithUser(targetUser);
    currentCallUser = targetUser;
    peerConnection = createPeerConnection(ch);

    try {
      // request media - robust handling
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoMini) localVideoMini.srcObject = localStream;
      localStream.getTracks().forEach(function (t) { try { peerConnection.addTrack(t, localStream); } catch (e) { } });

      var offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      try { ch.publish('call', { type: 'offer', offer: offer, from: username, to: targetUser }); } catch (e) { console.warn('publish offer failed', e); }

      if (videoModal) videoModal.style.display = 'flex';
    } catch (e) {
      console.error('Erro ao acessar câmera/microfone:', e);
      alert('Não foi possível acessar sua câmera/microfone. Verifique se o site está em HTTPS e se você permitiu o acesso no navegador.');
      // cleanup partially created pc/stream
      try { if (peerConnection) peerConnection.close(); } catch (er) { }
      peerConnection = null;
      if (localStream) {
        try { localStream.getTracks().forEach(t => t.stop()); } catch (er) { }
        localStream = null;
      }
      currentCallUser = null;
    }
  }

  async function handleCallSignal(data, channel) {
    if (!data) return;
    // if message not intended for this client ignore
    if (data.to && data.to !== username) return;

    // ensure private channel mapping
    var from = data.from;
    if (!from) return;

    if (!privateChannels['chat-' + [username, from].sort().join('-')] && privateChannels[channel.name]) {
      // ensure mapping
      privateChannels[channel.name] = channel;
    }

    // set currentCallUser to the caller
    currentCallUser = from;

    // create peerConnection if needed (use the channel passed)
    if (!peerConnection) peerConnection = createPeerConnection(channel);

    if (data.type === 'offer') {
      // incoming call
      callerLabel.textContent = data.from + ' está chamando...';
      callModal.style.display = 'flex';

      acceptCallBtn.onclick = async function () {
        callModal.style.display = 'none';
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          if (localVideoMini) localVideoMini.srcObject = localStream;
          localStream.getTracks().forEach(function (t) { try { peerConnection.addTrack(t, localStream); } catch (e) { } });

          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
          var answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          try { channel.publish('call', { type: 'answer', answer: answer, from: username, to: data.from }); } catch (e) { }
          videoModal.style.display = 'flex';
        } catch (e) {
          console.error('Erro ao aceitar chamada:', e);
          alert('Não foi possível acessar câmera/microfone ao aceitar a chamada. Verifique permissões.');
          if (peerConnection) { try { peerConnection.close(); } catch (er) { } }
          peerConnection = null;
          currentCallUser = null;
        }
      };

      declineCallBtn.onclick = function () {
        callModal.style.display = 'none';
        currentCallUser = null;
        try { channel.publish('call', { type: 'end', from: username, to: data.from }); } catch (e) { }
      };
    } else if (data.type === 'answer') {
      // called party answered
      try {
        if (peerConnection && data.answer) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          videoModal.style.display = 'flex';
        }
      } catch (e) { console.error('Erro ao setRemoteDescription (answer):', e); }
    } else if (data.type === 'ice') {
      try {
        if (peerConnection && data.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (e) { console.warn('addIceCandidate failed', e); }
    } else if (data.type === 'end') {
      // remote ended
      if (peerConnection) {
        try { peerConnection.close(); } catch (e) { }
        peerConnection = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } });
        localStream = null;
      }
      if (remoteStream) {
        try { remoteStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } }); } catch (e) { }
        remoteStream = null;
      }
      if (videoModal) videoModal.style.display = 'none';
      currentCallUser = null;
    }
  }

  // ----------------- Call controls (end, mute audio, mute video) -----------------
  if (endCallBtn) {
    endCallBtn.addEventListener('click', function () {
      if (peerConnection) {
        try {
          // remove senders/tracks
          peerConnection.getSenders().forEach(function (s) {
            try { peerConnection.removeTrack(s); } catch (e) { }
          });
        } catch (e) { }
        try { peerConnection.close(); } catch (e) { }
        peerConnection = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(function (track) { track.stop(); });
        localStream = null;
      }
      if (remoteStream) {
        try { remoteStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
        remoteStream = null;
      }
      if (videoModal) videoModal.style.display = 'none';
      // notify remote
      try {
        if (currentCallUser && privateChannels[currentCallUser]) {
          privateChannels[currentCallUser].publish('call', { type: 'end', from: username, to: currentCallUser });
        } else {
          // try to resolve channel name if mapping is chat-...
          var chName = 'chat-' + [username, currentCallUser].sort().join('-');
          if (privateChannels[chName]) privateChannels[chName].publish('call', { type: 'end', from: username, to: currentCallUser });
        }
      } catch (e) { }
      currentCallUser = null;
    });
  }

  if (muteAudioBtn) {
    muteAudioBtn.addEventListener('click', function () {
      if (!localStream) return;
      var tracks = localStream.getAudioTracks();
      if (!tracks || tracks.length === 0) return;
      var newState = !tracks[0].enabled;
      tracks.forEach(function (t) { t.enabled = newState; });
      // update text/icon
      muteAudioBtn.textContent = newState ? 'Mudo' : 'Áudio On';
      // optional: toggle a class
      if (newState) muteAudioBtn.classList.add('active'); else muteAudioBtn.classList.remove('active');
    });
  }

  if (muteVideoBtn) {
    muteVideoBtn.addEventListener('click', function () {
      if (!localStream) return;
      var tracks = localStream.getVideoTracks();
      if (!tracks || tracks.length === 0) return;
      var newState = !tracks[0].enabled;
      tracks.forEach(function (t) { t.enabled = newState; });
      muteVideoBtn.textContent = newState ? 'Vídeo Off' : 'Vídeo On';
      if (newState) muteVideoBtn.classList.add('active'); else muteVideoBtn.classList.remove('active');
    });
  }

  // ----------------- Voice recording (MediaRecorder) -----------------
  async function startRecording() {
    if (isRecording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Seu navegador não suporta gravação de áudio.');
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // create MediaRecorder
      mediaRecorder = new MediaRecorder(stream);
      recordedChunks = [];
      mediaRecorder.ondataavailable = function (evt) {
        if (evt.data && evt.data.size > 0) recordedChunks.push(evt.data);
      };
      mediaRecorder.onstop = function () {
        // stop tracks
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) { }
        // create blob
        var blob = new Blob(recordedChunks, { type: 'audio/ogg; codecs=opus' });
        // get duration using audio element
        var audioURL = URL.createObjectURL(blob);
        var tempAudio = new Audio();
        tempAudio.src = audioURL;
        tempAudio.addEventListener('loadedmetadata', function () {
          var dur = Math.round(tempAudio.duration);
          var mm = Math.floor(dur / 60);
          var ss = dur % 60;
          var durationText = (mm < 10 ? '0' + mm : mm) + ':' + (ss < 10 ? '0' + ss : ss);

          // convert to data URL and send
          var reader = new FileReader();
          reader.onloadend = function () {
            var base64data = reader.result; // data:audio/ogg;base64,...
            // store in chat history
            var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            var id = genMessageId();
            chatHistory[currentChatUser] = chatHistory[currentChatUser] || [];
            chatHistory[currentChatUser].push({ id: id, sender: username, text: 'Mensagem de voz', file: base64data, type: 'audio', time: time, duration: durationText });
            if (chatHistory[currentChatUser].length > 200) chatHistory[currentChatUser].shift();
            addMessageToDom(username, 'Mensagem de voz', time, false, base64data, 'audio', durationText);
            seenMessageIds.add(id);

            // publish via Ably
            try {
              if (currentChatIsGroup) {
                var ch = ensurePrivateChannelWithUser('group:' + currentChatUser);
                if (ch) ch.publish('message', { id: id, username: username, text: 'Mensagem de voz', file: base64data, type: 'audio', time: time, duration: durationText, groupId: currentChatUser });
              } else {
                var ch = ensurePrivateChannelWithUser(currentChatUser);
                if (ch) ch.publish('message', { id: id, username: username, text: 'Mensagem de voz', file: base64data, type: 'audio', time: time, duration: durationText });
              }
            } catch (e) { console.warn('publish audio failed', e); }

          };
          reader.readAsDataURL(blob);
          URL.revokeObjectURL(audioURL);
        });
      };

      mediaRecorder.start();
      isRecording = true;
      // visual cue: slight color change
      if (micBtn) micBtn.style.background = 'rgba(75,108,183,0.12)'; // light tint
      if (micBtn) micBtn.style.color = '#2c3e81';
      // optional small label "Gravando..." next to mic
      if (messageInput) {
        micBtn.dataset.prevTitle = micBtn.title;
        micBtn.title = 'Gravando... Clique para parar';
      }
    } catch (err) {
      console.error('Erro ao acessar microfone para gravação:', err);
      alert('Não foi possível acessar o microfone. Verifique as permissões do navegador.');
      isRecording = false;
      if (micBtn) micBtn.style.background = 'transparent';
      if (micBtn) micBtn.title = 'Gravar mensagem de voz';
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    try {
      mediaRecorder.stop();
    } catch (e) { console.warn(e); }
    isRecording = false;
    if (micBtn) micBtn.style.background = 'transparent';
    if (micBtn) micBtn.title = micBtn.dataset.prevTitle || 'Gravar mensagem de voz';
    mediaRecorder = null;
  }

  // mic button actions: toggle start/stop on click
  if (micBtn) {
    micBtn.addEventListener('click', function () {
      // require an opened chat to send voice
      if (!currentChatUser) {
        alert('Abra um chat antes de gravar uma mensagem de voz.');
        return;
      }
      if (!isRecording) startRecording();
      else stopRecording();
    });
  }

  // ----------------- DOM Events (login, send message, menu, close chat) -----------------
  if (enterChatBtn) {
    enterChatBtn.addEventListener('click', function () {
      var v = (document.getElementById('username') || {}).value || '';
      v = v.trim(); if (!v) { alert('Digite seu nome!'); return; }
      username = v;
      if (loginScreen) loginScreen.style.display = 'none';
      if (chatScreen) chatScreen.style.display = 'flex';
      initAbly();
    });
  }

  if (sendMessageBtn && messageInput) {
    sendMessageBtn.addEventListener('click', function () {
      if (!currentChatUser) { alert('Abra um chat primeiro.'); return; }
      if (currentChatIsGroup) {
        var ch = ensurePrivateChannelWithUser('group:' + currentChatUser);
        sendMessage(ch);
      } else {
        var ch = ensurePrivateChannelWithUser(currentChatUser);
        sendMessage(ch);
      }
    });

    messageInput.addEventListener('keypress', function (e) {
      if (!currentChatUser) return;
      if (e.key === 'Enter') {
        if (currentChatIsGroup) {
          var ch = ensurePrivateChannelWithUser('group:' + currentChatUser);
          sendMessage(ch);
        } else {
          var ch = ensurePrivateChannelWithUser(currentChatUser);
          sendMessage(ch);
        }
      } else {
        try {
          if (currentChatIsGroup) {
            var ch = ensurePrivateChannelWithUser('group:' + currentChatUser);
            if (ch) ch.publish('typing', { username: username, groupId: currentChatUser });
          } else {
            var ch = ensurePrivateChannelWithUser(currentChatUser);
            if (ch) ch.publish('typing', { username: username });
          }
        } catch (e) { }
      }
    });
  }

  if (menuHamburger) {
    menuHamburger.addEventListener('click', function () {
      if (window.innerWidth <= 900 && contactsList) contactsList.classList.toggle('open');
    });
  }

  if (closeChatBtn) {
    closeChatBtn.addEventListener('click', function () {
      if (messagesDiv) messagesDiv.innerHTML = '';
      if (inputArea) inputArea.style.display = 'none';
      closeChatBtn.style.display = 'none';
      currentChatUser = null;
      currentChatIsGroup = false;
    });
  }

  if (attachFileBtn && fileInput) setupFileUpload();

  // ----------------- Subscribe call events for every private channel periodically (safe-guard) -----------------
  setInterval(function () {
    if (!privateChannels) return;
    Object.keys(privateChannels).forEach(function (u) {
      var ch = privateChannels[u];
      try { ch.subscribe('call', function (msg) { handleCallSignal(msg.data, ch); }); } catch (e) { }
    });
  }, 2000);

  // initial UI state
  if (inputArea) inputArea.style.display = 'none';
  renderContacts();

  // ----------------- Helpful note for devs (not runtime) -----------------
  // IMPORTANT: navigator.mediaDevices.getUserMedia requires HTTPS (except on localhost).
  // If you're testing by opening the file via file:// the camera won't be accessible.
  // Use Live Server (VSCode) or python -m http.server or host via HTTPS.

}); // DOMContentLoaded end
