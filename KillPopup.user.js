// ==UserScript==
// @name         Glorp Kill Popup
// @namespace    local.glorp.killpopup
// @version      2.2.0
// @description  Two-line kill confirmation from Krunker chat and killfeed HUD layouts.
// @match        https://krunker.io/*
// @run-at document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';
    if (window.top !== window.self || location.hostname !== 'krunker.io' ||
        !['/', '/index.html'].includes(location.pathname)) return;
    if (window.__glorpKillConfirmV2) return;
    window.__glorpKillConfirmV2 = true;

    /* Current Krunker renderer inspected in an isolated guest page on 2026-10-20.
       leaderType 0 emits chatMsg in chatList; other layouts emit killfeedMsg in killFeed.
       The local killer is a white You span. A victim's outer span may contain a clan span.
       This is DOM-only: no packets, engine patches, score inference or username lookup.
       Diagnostics: GlorpKillPopup.diagnostics.start(90), then .snapshot().
       Native-renderer samples were tested; an actual local kill remains manual acceptance.
    */
    const STORAGE_KEY = 'glorp_killconfirm_v1';
    const defaults = Object.freeze({
        enabled: true, textColor: '#f2f2f2', accentColor: '#f2ad38',
        opacity: 88, labelSize: 13, nameSize: 17, duration: 2.4, offsetY: 48,
        hideButton: true, buttonX: 16, buttonY: 155,
        fadeIn: 0.15, fadeOut: 0.25, hideNativeFeed: true, lineGap: 0, menuKey: 'F3',
    });
    const limits = { opacity:[0,100], labelSize:[8,48], nameSize:[8,64],
        duration:[0.3,10], offsetY:[8,300], buttonX:[0,2000], buttonY:[0,1400], fadeIn:[0,3], fadeOut:[0,3], lineGap:[0,50] };
    const color = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    const clamp = (v, lo, hi, fallback) => v !== null && v !== '' &&
        ['number','string'].includes(typeof v) && Number.isFinite(Number(v))
        ? Math.min(hi, Math.max(lo, Number(v))) : fallback;
    let settings = { ...defaults };
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            if(typeof saved.menuKey==='string' && saved.menuKey.length<=80) settings.menuKey=saved.menuKey;
            for (const key of ['enabled','hideButton','hideNativeFeed']) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
            for (const key of ['textColor','accentColor']) if (color(saved[key])) settings[key] = saved[key];
            // Preserve the old victim size and its original .78-em label size.
            const oldSize = clamp(saved.size,11,28,defaults.nameSize);
            for (const [key,[lo,hi]] of Object.entries(limits)) {
                const fallback = key === 'nameSize' ? oldSize : key === 'labelSize' ? Math.round(oldSize*.78) : defaults[key];
                settings[key] = clamp(saved[key],lo,hi,fallback);
            }
        }
    } catch { /* Storage is optional. */ }
    if(settings.menuKey && shortcutConflict(settings.menuKey)) settings.menuKey=['F3','F4','F9','F10'].find(key=>!shortcutConflict(key))||'';
    function sourceEnabled() {
        try {const value=localStorage.getItem('kro_setngss_showKills');return value==='false'?false:value==='true'?true:null;}catch{return null;}
    }
    function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {} }

    let host, root, hud, panel, toolbar, trigger, noticeTimer, noticeAnimation, nativeStyle, visible = false, recordingKey=false;
    let chatList, killFeed, chatObserver, feedObserver, discoveryObserver;
    let started = false, stopped = false, diagnosticTimer, diagnosticUntil = 0;
    let diagnosticRecords = [], diagnosticCount = 0, observedKills = 0;
    const seenNodes = new WeakSet();
    const seenIds = new Map();
    const pending = new Set();
    let queued = false;
    const bootTime = Date.now();

    function log(kind, detail) {
        if (Date.now() >= diagnosticUntil || diagnosticCount >= 20) return;
        const entry = { ms:Date.now()-bootTime, kind, detail };
        diagnosticRecords.push(entry); diagnosticCount++;
        console.info('[KillPopup diagnostic]', entry);
    }
    function startDiagnostics(seconds = 90) {
        clearTimeout(diagnosticTimer);
        diagnosticRecords = []; diagnosticCount = 0;
        diagnosticUntil = Date.now() + clamp(seconds,5,180,90)*1000;
        log('status', { chatList:!!chatList, killFeed:!!killFeed,
            adapter:'Krunker chat + killfeed HUD layouts', observedKills });
        diagnosticTimer = setTimeout(stopDiagnostics, diagnosticUntil-Date.now());
    }
    function stopDiagnostics() {
        diagnosticUntil = 0; clearTimeout(diagnosticTimer);
        console.info('[KillPopup] Diagnostic capture stopped. Records remain in GlorpKillPopup.diagnostics.snapshot().');
    }
    window.GlorpKillPopup = window.GlorpKillConfirm = Object.freeze({
        version:'2.2.0',
        diagnostics:Object.freeze({start:startDiagnostics,stop:stopDiagnostics,
            snapshot:() => JSON.parse(JSON.stringify({liveVerified:false, observedKills, eventSourceEnabled:sourceEnabled(),
                chatList:!!chatList?.isConnected, killFeed:!!killFeed?.isConnected,
                records:diagnosticRecords}))}),
    });

    // Inspect only native kill-message structure, with the explicit local marker.
    function parseMessage(message) {
        if (!message.matches('span.chatMsg,span.killfeedMsg')) return {reason:'not-kill-message'};
        const names=[...message.children].filter(el=>el.tagName==='SPAN' && el.style.color);
        const images=[...message.children].filter(el=>el.tagName==='IMG');
        if (!images.length) return {reason:'no-kill-image'};
        const weapon=images.some(el=>{
            if(el.matches('.weaponChatIcon,.meleeChatIcon,.fistChatIcon,.streakChatIcon'))return true;
            try{return !el.className && /\/img\/weapons\/icon_[\w-]+\.png$/.test(new URL(el.getAttribute('src')||'',location.href).pathname);}catch{return false;}
        });
        if (!weapon) return {reason:'not-weapon-icon'};
        if(names.length!==2) return {reason:'ambiguous-name-spans'};
        const [killer,victim]=names, children=[...message.children];
        if(children[0]!==killer || children.at(-1)!==victim || !children.slice(1,-1).every(el=>el.tagName==='IMG')) return {reason:'unexpected-message-order'};
        if(killer.children.length || killer.textContent.trim()!=='You' || killer.style.color.toLowerCase()!=='rgb(255, 255, 255)') return {reason:'not-explicit-local-killer'};
        // The renderer appends a colored [CLAN] span inside the victim span.
        // Keep the alias's direct text exactly; never treat clan text as the name.
        if([...victim.children].some(el=>el.tagName!=='SPAN' || el.children.length || !/^\s*\[[^\[\]\r\n]{1,64}\]$/.test(el.textContent))) return {reason:'unverified-name-decoration'};
        const name=[...victim.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim();
        if(!name || name.length>64 || /[\u0000-\u001f\u007f]/u.test(name)) return {reason:'invalid-victim-name'};
        return {victim:name};
    }
    function diagnosticMessage(message, result) {
        // Only candidate kill messages; never dump chat history, account storage,
        // tokens, URLs with query strings, or network payloads.
        if (!message.querySelector('img')) return;
        log('candidate', { reason:result.reason || 'accepted-local-kill',
            spans:[...message.querySelectorAll('span')].slice(0,6).map(e=>({
                text:e.textContent.slice(0,64), color:e.style.color, children:e.children.length })),
            images:[...message.querySelectorAll('img')].slice(0,3).map(e=>{
                try { const u=new URL(e.getAttribute('src')||'',location.href); return u.origin+u.pathname; } catch { return ''; }
            }) });
    }
    function processMessage(message) {
        if (seenNodes.has(message) || !message.isConnected || !(chatList?.contains(message)||killFeed?.contains(message))) return;
        const result = parseMessage(message);
        diagnosticMessage(message,result);
        if (!result.victim) return;
        seenNodes.add(message);
        const row = message.closest('[id^="chatMsg_"],[id^="feed_"]');
        const id = row?.id;
        const signature = message.innerHTML;
        // DOM identity handles repeated mutations/reparenting. Native row identity
        // also suppresses clones while the original is present. Native row IDs are
        // recycled after removal, so they must never permanently suppress a new kill.
        const previous=id && seenIds.get(id);
        if(previous?.signature===signature && previous.node?.isConnected) return;
        if (id) {
            seenIds.delete(id); seenIds.set(id,{signature,node:message});
            if (seenIds.size > 256) seenIds.delete(seenIds.keys().next().value);
        }
        observedKills++;
        showKill(result.victim);
    }
    function collect(node) {
        if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        if (node?.nodeType !== Node.ELEMENT_NODE) return;
        const enclosing = node.closest('span.chatMsg,span.killfeedMsg');
        if (enclosing) pending.add(enclosing);
        node.querySelectorAll('span.chatMsg,span.killfeedMsg').forEach(e=>pending.add(e));
        if (!queued && pending.size) {
            queued = true;
            queueMicrotask(() => { queued=false; const batch=[...pending]; pending.clear(); batch.forEach(processMessage); });
        }
    }
    function connectSources() {
        const next = document.querySelector('#chatList');
        if (next !== chatList) {
            chatObserver?.disconnect(); chatList = next;
            for(const id of seenIds.keys())if(id.startsWith('chatMsg_'))seenIds.delete(id);
            if (chatList) {
                // Existing entries are history. Do not replay on injection or rebuild.
                for (const message of chatList.querySelectorAll('span.chatMsg')) {
                    seenNodes.add(message);
                    const id=message.closest('[id^="chatMsg_"]')?.id;
                    if (id) { seenIds.set(id,{signature:message.innerHTML,node:message}); if(seenIds.size>256) seenIds.delete(seenIds.keys().next().value); }
                }
                chatObserver = new MutationObserver(records => {
                    if (!chatList.children.length) for(const id of seenIds.keys())if(id.startsWith('chatMsg_'))seenIds.delete(id);
                    for (const record of records) {
                        if (record.type === 'childList') { record.addedNodes.forEach(collect); collect(record.target); }
                        else collect(record.target);
                    }
                });
                chatObserver.observe(chatList,{childList:true,subtree:true,characterData:true});
            }
            log('chat-source',{connected:!!chatList,historyIgnored:true});
        }
        const nextFeed = document.querySelector('#killFeed');
        if (nextFeed !== killFeed) {
            feedObserver?.disconnect(); killFeed = nextFeed;
            if (killFeed) {
                for(const message of killFeed.querySelectorAll('span.killfeedMsg')) {
                    seenNodes.add(message);
                    const id=message.closest('[id^="feed_"]')?.id;
                    if(id){seenIds.set(id,{signature:message.innerHTML,node:message});if(seenIds.size>256)seenIds.delete(seenIds.keys().next().value);}
                }
                feedObserver=new MutationObserver(records=>{
                    if(!killFeed.children.length) for(const id of seenIds.keys()) if(id.startsWith('feed_'))seenIds.delete(id);
                    for(const record of records){
                        if(record.type==='childList'){record.addedNodes.forEach(collect);collect(record.target);}
                        else collect(record.target);
                    }
                });
                feedObserver.observe(killFeed,{childList:true,subtree:true,characterData:true});
            }
        }
    }
    function showKill(victim, test = false) {
        if (!hud || (!settings.enabled && !test)) return;
        clearTimeout(noticeTimer);
        const from = hud.hidden ? 0 : Number(getComputedStyle(hud).opacity);
        noticeAnimation?.cancel();
        hud.querySelector('.kc-victim').textContent = victim;
        hud.hidden = false;
        // Display duration includes both fades. Scale long fades to fit instead of
        // extending a notice or leaving an old completion callback alive.
        const total=settings.duration*1000, target=settings.opacity/100;
        const scale=Math.min(1,settings.duration/Math.max(settings.fadeIn+settings.fadeOut,0.001));
        const enter=settings.fadeIn*1000*scale, exit=settings.fadeOut*1000*scale;
        const frames=[{opacity:enter ? from : target,offset:0}];
        if(enter) frames.push({opacity:target,offset:enter/total});
        frames.push({opacity:target,offset:1-exit/total});
        if(exit) frames.push({opacity:0,offset:1});
        if((enter||exit) && typeof hud.animate==='function') noticeAnimation=hud.animate(frames,{duration:total,fill:'both',easing:'linear'});
        noticeTimer = setTimeout(()=>{hud.hidden=true;noticeAnimation?.cancel();noticeAnimation=null;},total);
    }
    function applySettings() {
        if (!root) return;
        const hint=settings.menuKey?' ('+settings.menuKey+')':'';
        trigger.textContent='KILL POPUP'+hint;
        root.querySelector('#kc-close').textContent='CLOSE'+hint+' ×';
        root.querySelector('#kc-bind').textContent=recordingKey?'PRESS KEY…':settings.menuKey||'OFF';
        root.querySelector('#kc-source-warning').hidden=!settings.enabled || sourceEnabled()!==false;
        // Keep native event generation intact; hide presentation only. Ordinary
        // chat and system messages stay visible in the chat-based feed layout.
        if(!nativeStyle){nativeStyle=document.createElement('style');nativeStyle.id='kc-native-feed-style';document.head.append(nativeStyle);}
        nativeStyle.textContent=settings.enabled && settings.hideNativeFeed ? `
          #killFeed{display:none!important}
          #chatList [id^="chatMsg_"]:has(span.chatMsg > img.weaponChatIcon),
          #chatList [id^="chatMsg_"]:has(span.chatMsg > img.meleeChatIcon),
          #chatList [id^="chatMsg_"]:has(span.chatMsg > img.fistChatIcon),
          #chatList [id^="chatMsg_"]:has(span.chatMsg > img.streakChatIcon),
          #chatList [id^="chatMsg_"]:has(span.chatMsg > img[src*="/img/weapons/icon_"]){display:none!important}
        ` : '';
        for (const [css,key,unit] of [['color','textColor',''],['accent','accentColor',''],
            ['label-size','labelSize','px'],['name-size','nameSize','px'],['offset','offsetY','px'],['line-gap','lineGap','px']])
            host.style.setProperty('--kc-'+css,settings[key]+unit);
        host.style.setProperty('--kc-opacity',String(settings.opacity/100));
        // Clamp the rendered location to the viewport while preserving saved offsets.
        toolbar.style.right=`${Math.min(settings.buttonX,Math.max(0,innerWidth-200))}px`;
        toolbar.style.top=`${Math.min(settings.buttonY,Math.max(0,innerHeight-60))}px`;
        toolbar.dataset.hidden=String(settings.hideButton && !visible);
        if (!settings.enabled) { clearTimeout(noticeTimer); noticeAnimation?.cancel(); noticeAnimation=null; hud.hidden=true; }
    }
    function closeMenu() {
        if (!visible) return;
        visible=false; recordingKey=false; panel.hidden=true; trigger.setAttribute('aria-expanded','false');
        applySettings(); trigger.focus({preventScroll:true});
    }
    function openMenu() {
        if (visible) return;
        visible=true; panel.hidden=false; trigger.setAttribute('aria-expanded','true');
        try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
        applySettings(); root.querySelector('#kc-close').focus();
    }
    function buildUI() {
        host=document.createElement('div'); host.id='glorp-kill-confirm-root';
        host.style.cssText='position:fixed;inset:0;z-index:2147482900;pointer-events:none;';
        document.body.append(host); root=host.attachShadow({mode:'open'});
        root.innerHTML=`<style>
        :host{color:#eee;color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}
        #kc-hud{position:fixed;left:50%;top:calc(50% + var(--kc-offset));transform:translateX(-50%);width:max-content;max-width:95vw;text-align:center;pointer-events:none;opacity:var(--kc-opacity);font-family:gamefont,GameFont,sans-serif;text-shadow:1px 2px 2px #000,-1px -1px 1px #000}
        .kc-label,.kc-victim{display:block;line-height:1.3;white-space:pre;color:var(--kc-color)}
        .kc-label{font-size:var(--kc-label-size)}.kc-victim{font-size:var(--kc-name-size);color:var(--kc-accent);margin-top:var(--kc-line-gap)}
        #kc-toolbar{position:fixed;pointer-events:auto;padding:6px;display:flex;justify-content:flex-end}
        #kc-open{font:12px/1.5 gamefont,GameFont,sans-serif;background:linear-gradient(#414141,#242424);border:3px solid #111;box-shadow:0 5px #111;text-transform:uppercase;white-space:nowrap;padding:9px 11px}
        #kc-toolbar[data-hidden=true]:not(:hover):not(:focus-within) #kc-open{opacity:0}
        #kc-panel{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000a;padding:16px;pointer-events:auto}
        .kc-window{width:510px;max-width:100%;max-height:calc(100dvh - 32px);overflow:auto;border:4px solid #111;background:linear-gradient(180deg,#303030,#222 45%,#161616);box-shadow:0 8px #080808,0 18px 60px #000b;font:12px/1.5 gamefont,GameFont,sans-serif}
        header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;background:linear-gradient(#454545,#303030);border-bottom:4px solid #151515}
        h2{margin:0;font-size:20px;font-weight:normal;text-shadow:2px 3px #111}
        .kc-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;padding:20px}
        label{display:flex;flex-direction:column;gap:7px;min-width:0;color:#d2d2d2}.kc-check{flex-direction:row;align-items:center}.kc-wide{grid-column:1/-1}
        button,input{font:inherit;border-radius:0}button{cursor:pointer;border:2px solid #111;background:linear-gradient(#494949,#303030);color:#fff;box-shadow:inset 0 2px #ffffff18,0 4px #151515;padding:8px 12px;text-shadow:1px 2px #0008}
        button:hover{background:linear-gradient(#606060,#414141)}button:focus-visible,input:focus-visible{outline:2px solid #f4b64c;outline-offset:2px}
        input[type=number]{width:100%;min-width:0;padding:8px;border:2px solid #111;background:linear-gradient(#171717,#242424);color:#eee;box-shadow:inset 0 2px #0005}
        input[type=color]{width:100%;height:34px;padding:2px;border:2px solid #111;background:#222}
        input[type=checkbox]{accent-color:#e5a239;width:16px;height:16px}
        #kc-source-warning{margin:0;color:#e5a239}
        #kc-test{background:linear-gradient(#e7a43b,#b67416);border-color:#17120a}
        @media(max-width:420px){.kc-body{grid-template-columns:1fr}header{padding:12px}h2{font-size:16px}}
        </style>
        <div id="kc-hud" hidden aria-live="off"><span class="kc-label">ELIMINATED</span><span class="kc-victim">PlayerName</span></div>
        <div id="kc-toolbar"><button id="kc-open" type="button" aria-expanded="false" aria-controls="kc-panel">KILL POPUP</button></div>
        <div id="kc-panel" hidden><section class="kc-window" role="dialog" aria-modal="true" aria-labelledby="kc-title">
        <header><h2 id="kc-title">KILL POPUP</h2><button id="kc-close" type="button">CLOSE ×</button></header>
        <div class="kc-body">
        <label class="kc-check kc-wide"><input id="kc-enabled" type="checkbox">Enable Kill Popup</label><p id="kc-source-warning" class="kc-wide" hidden role="alert">Enable Show Kill Feed in Krunker Settings. The game does not generate kill messages while it is off.</p>
        <label>ELIMINATED size (px)<input id="kc-labelSize" type="number" min="8" max="48" step="1"></label>
        <label>Player name size (px)<input id="kc-nameSize" type="number" min="8" max="64" step="1"></label>
        <label>Line spacing (px)<input id="kc-lineGap" type="number" min="0" max="50" step="1"></label>
        <label>Menu key<input id="kc-menuKey" type="hidden"><button id="kc-bind" type="button">F3</button><button id="kc-unbind" type="button">OFF</button></label><p id="kc-bind-error" class="kc-wide" hidden role="alert"></p>
        <label>ELIMINATED color<input id="kc-textColor" type="color"></label>
        <label>Player name color<input id="kc-accentColor" type="color"></label>
        <label>Opacity (%)<input id="kc-opacity" type="number" min="0" max="100" step="1"></label>
        <label>Display duration (s)<input id="kc-duration" type="number" min="0.3" max="10" step="0.1"></label>
        <label>Fade in (s)<input id="kc-fadeIn" type="number" min="0" max="3" step="0.05" title="0 = instant. Fades fit inside display duration."></label>
        <label>Fade out (s)<input id="kc-fadeOut" type="number" min="0" max="3" step="0.05" title="0 = instant. Fades fit inside display duration."></label>
        <label class="kc-check kc-wide"><input id="kc-hideNativeFeed" type="checkbox">Hide native kill messages</label>
        <label class="kc-wide">Beneath crosshair (px)<input id="kc-offsetY" type="number" min="8" max="300" step="1"></label>
        <label>Button from right (px)<input id="kc-buttonX" type="number" min="0" max="2000" step="1"></label>
        <label>Button from top (px)<input id="kc-buttonY" type="number" min="0" max="1400" step="1"></label>
        <label class="kc-check kc-wide"><input id="kc-hideButton" type="checkbox">Hide button until hovered</label>
        <button id="kc-test" class="kc-wide" type="button">TEST NOTIFICATION</button>
        </div></section></div>`;
        hud=root.querySelector('#kc-hud'); panel=root.querySelector('#kc-panel');
        toolbar=root.querySelector('#kc-toolbar'); trigger=root.querySelector('#kc-open');
        trigger.addEventListener('click',openMenu); root.querySelector('#kc-close').addEventListener('click',closeMenu);
        panel.addEventListener('click',e=>{if(e.target===panel) closeMenu();});
        root.querySelector('#kc-bind').addEventListener('click',()=>{recordingKey=true;applySettings();});
        root.querySelector('#kc-unbind').addEventListener('click',()=>{recordingKey=false;settings.menuKey='';save();applySettings();});
        for (const key of Object.keys(defaults)) {
            const input=root.querySelector('#kc-'+key);
            if (input.type==='checkbox') input.checked=settings[key]; else input.value=settings[key];
            input.addEventListener('change',()=>{
                if(input.type==='checkbox') settings[key]=input.checked;
                else if(limits[key]) settings[key]=clamp(input.value,...limits[key],settings[key]);
                else if(color(input.value)) settings[key]=input.value;
                input.value=settings[key]; save(); applySettings();
            });
        }
        root.querySelector('#kc-test').addEventListener('click',()=>{closeMenu();showKill('PlayerName',true);});
        root.addEventListener('keydown',e=>{
            if(!visible) return;
            if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu();}
            if(e.key==='Tab'){
                const controls=[...panel.querySelectorAll('button,input')];
                const first=controls[0],last=controls.at(-1);
                if(e.shiftKey&&root.activeElement===first){e.preventDefault();last.focus();}
                else if(!e.shiftKey&&root.activeElement===last){e.preventDefault();first.focus();}
            }
        });
        // Do not steal F6: Glorp binds it to finding another lobby.
        applySettings();
    }
    function popupShortcut(event) {
        if(['Control','Alt','Shift','Meta','Dead','Unidentified'].includes(event.key)) return '';
        return [event.ctrlKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',event.metaKey?'Meta':'',event.key===' '?'Space':event.key.length===1?event.key.toUpperCase():event.key].filter(Boolean).join('+');
    }
    function shortcutConflict(key) {
        if(key==='F6') return true;
        try {
            const f=JSON.parse(localStorage.getItem('glorp_matchmaker_v1')||'null')?.filters;
            return ['menuKey','switchKey','autoKey'].some((name,i)=>String(f?.[name]??['F2','F8','F7'][i]).toUpperCase()===key.toUpperCase());
        }catch{return ['F2','F8','F7'].includes(key);}
    }
    window.addEventListener('keydown',event=>{
        if(!root || stopped || event.repeat || event.isComposing) return;
        const key=popupShortcut(event);
        if(recordingKey) {
            if(!key)return;
            event.preventDefault();event.stopImmediatePropagation();
            const error=root.querySelector('#kc-bind-error');
            if(shortcutConflict(key)) {error.textContent='That key is already assigned.';error.hidden=false;return;}
            error.hidden=true;settings.menuKey=key;recordingKey=false;root.querySelector('#kc-menuKey').value=key;save();applySettings();return;
        }
        const target=event.composedPath?.()[0]||event.target;
        if(!key || key.toUpperCase()!==settings.menuKey.toUpperCase() || shortcutConflict(key) || target?.closest?.('input,textarea,select,[contenteditable=true]'))return;
        event.preventDefault();event.stopImmediatePropagation();
        if(visible)closeMenu();else openMenu();
    },true);
    function syncPointerLock() { if(document.pointerLockElement&&visible) closeMenu(); toolbar.hidden=!!document.pointerLockElement; }
    function stop() {
        stopped=true; chatObserver?.disconnect(); feedObserver?.disconnect(); discoveryObserver?.disconnect();
        chatList=null; killFeed=null;
        clearTimeout(noticeTimer); clearTimeout(diagnosticTimer); diagnosticUntil=0;
        noticeAnimation?.cancel(); nativeStyle?.remove(); nativeStyle=null;
        pending.clear(); if(hud) hud.hidden=true;
    }
    function start() {
        if(started||stopped) return; started=true;
        buildUI(); startDiagnostics(); connectSources(); syncPointerLock();
        // Event-driven source discovery/reconnection, no interval polling. Ignore
        // ordinary HUD mutations as soon as both known containers are connected.
        discoveryObserver=new MutationObserver(()=>{
            if(!chatList?.isConnected||!killFeed?.isConnected) connectSources();
        });
        discoveryObserver.observe(document.body,{childList:true,subtree:true});
        console.info('[KillPopup] Chat + killfeed HUD adapters installed. Test notification checks UI only.');
    }
    document.addEventListener('pointerlockchange',()=>{if(toolbar) syncPointerLock();});
    window.addEventListener('resize',applySettings);
    window.addEventListener('pagehide',stop);
    window.addEventListener('pageshow',e=>{if(e.persisted){stopped=false;started=false;host?.remove();start();}});
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
