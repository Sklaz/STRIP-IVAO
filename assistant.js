(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const panel = byId('ai-panel');
  const toggle = byId('ai-toggle');
  const chat = byId('ai-chat');
  const ask = byId('ai-ask');
  const importer = byId('ai-import');
  const askButton = ask.querySelector('[type=submit]');
  const importButton = importer.querySelector('[type=submit]');
  const histories = new Map();
  let airport = '';
  let manexUrl = '';
  let manexRequest = 0;
  let available = false;
  let configured = false;
  let provider = 'documents';
  let visualAvailable = false;
  let webSearch = false;
  let busy = false;
  let uploading = false;
  let documents = [];
  let documentRequest = 0;
  let poll;

  function el(tag,text,style) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (style) node.className = style;
    return node;
  }
  function href(value) {
    if (/^\/api\/assistant\/documents\/[a-f0-9-]{36}(?:#page=\d+)?$/.test(value ?? '')) return value;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function link(title,value) {
    const url = href(value);
    const node = el(url ? 'a' : 'span',title);
    if (url) {
      node.href = url;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    return node;
  }
  async function api(path,options) {
    let response;
    let data;
    try {
      response = await fetch('/api/assistant/' + path,options);
      data = await response.json();
    } catch {
      throw new Error('Le serveur local est indisponible.');
    }
    if (!response.ok) throw new Error(data?.error || 'Le serveur local est indisponible.');
    return data;
  }
  function history(code) {
    if (!histories.has(code)) {
      let rows = [];
      try {
        const saved = JSON.parse(localStorage.getItem('efs-assistant.v1.' + code) ?? '[]');
        if (Array.isArray(saved)) rows = saved.filter(row => row && ['user','assistant'].includes(row.role) && typeof row.text === 'string').slice(-60);
      } catch { /* Une ancienne sauvegarde illisible laisse la conversation vide. */ }
      histories.set(code,rows);
    }
    return histories.get(code);
  }
  function saveHistory(code) {
    const rows = history(code);
    if (rows.length > 60) rows.splice(0,rows.length - 60);
    try { localStorage.setItem('efs-assistant.v1.' + code,JSON.stringify(rows)); }
    catch { byId('ai-connection').textContent = 'Historique conservé pour cette session. Stockage local indisponible.'; }
  }
  function sourceList(sources) {
    const details = el('details',null,'ai-sources');
    details.append(el('summary',sources.length === 1 ? 'Source utilisée' : sources.length + ' sources utilisées'));
    const list = el('ul');
    const kinds = {published:'Publication AIS / AIP',ivao:'Documentation IVAO · simulation',imported:'Document importé',
      visual:'Lecture visuelle · vérifie la carte',simulation:'Données de simulation'};
    for (const source of sources) {
      const item = el('li');
      item.append(link(source.title,source.href));
      item.append(el('small',[kinds[source.type],source.category,source.page && 'p. ' + source.page,source.section,source.validity]
        .filter(Boolean).join(' · '),'ai-source-meta'));
      if (source.publisher) item.append(link('Lien éditeur indiqué',source.publisher));
      if (source.quote) item.append(el('blockquote',source.quote));
      list.append(item);
    }
    details.append(list);
    return details;
  }
  function answerText(answer) {
    return [...answer.parts.map(part => part.text),answer.missing,...answer.notices].filter(Boolean).join('\n\n');
  }
  function copyText(answer) {
    const references = (answer?.parts ?? []).flatMap(part => part.sources).map(source =>
      [source.title,source.page && 'p. ' + source.page,source.section,source.validity,
        href(source.publisher || source.href)].filter(Boolean).join(' · '));
    return [...new Set(references)].join('\n');
  }
  async function copyAnswer(text,answer,button) {
    const references = copyText(answer);
    const value = references ? text + '\n\n' + references : text;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'COPIÉ';
    } catch {
      const copy = el('textarea');
      copy.value = value;
      panel.append(copy);
      copy.select();
      try { button.textContent = document.execCommand('copy') ? 'COPIÉ' : 'COPIE INDISPONIBLE'; }
      catch { button.textContent = 'COPIE INDISPONIBLE'; }
      copy.remove();
    }
    setTimeout(() => button.textContent = 'COPIER',1800);
  }
  function message(row) {
    const card = el('article',null,'ai-message');
    card.dataset.role = row.role;
    card.append(el('h3',row.role === 'user' ? 'TOI' : 'ASSISTANT · ' + airport));
    if (!row.answer || !Array.isArray(row.answer.parts)) card.append(el('p',row.text));
    else {
      const labels = {excerpt:'Extrait du document',local:'Information documentaire',
        simulation:'Tableau de simulation',general:'Principe général'};
      for (const part of row.answer.parts) {
        const section = el('div',null,'ai-answer-part');
        section.append(el('div',labels[part.kind] ?? '', 'ai-kind'),el('p',part.text));
        const dates = [...new Set((part.sources ?? []).filter(source =>
          ['expired','future','unknown'].includes(source.validityState)).map(source => source.validity))];
        if (dates.length) section.append(el('small',dates.join(' · '),'ai-source-meta'));
        if (part.sources?.length) section.append(sourceList(part.sources));
        card.append(section);
      }
      if (row.answer.missing) card.append(el('p',row.answer.missing,'ai-answer-part'));
      for (const notice of row.answer.notices ?? []) card.append(el('p',notice,'muted ai-answer-part'));
      const button = el('button','COPIER','btn ai-copy');
      button.type = 'button';
      button.onclick = () => copyAnswer(row.text,row.answer,button);
      card.append(button);
    }
    return card;
  }
  function renderChat() {
    const rows = history(airport);
    chat.replaceChildren(...rows.map(message));
    if (!rows.length) chat.append(el('p','Cherche une fréquence, une piste ou une procédure dans le MANEX de cet aérodrome.','help'));
    chat.scrollTop = chat.scrollHeight;
  }
  function renderControls() {
    askButton.disabled = busy || !available;
    askButton.textContent = 'POSER LA QUESTION';
    byId('ai-board-option').hidden = !configured;
    byId('ai-visual-options').hidden = !visualAvailable;
    byId('ai-online-label').textContent = webSearch ? 'Consulter la météo et rechercher dans les publications AIS' :
      'Consulter la météo et l’eAIP France en ligne';
    byId('ai-send-hint').textContent = provider === 'openai' ? 'Question et contexte transmis à OpenAI.' :
      provider === 'ollama' ? 'Réponses rédigées sur ce PC.' : 'Sources IVAO, SIA et Aviation Weather Center.';
    importButton.disabled = uploading || !available;
  }
  function syncContext() {
    const current = window.efsAssistantContext();
    byId('ai-context').textContent = current.airport + ' · ' + current.airportName +
      (current.selected ? ' · Vol ' + current.selected.callsign : '');
    const changedAirport = airport !== current.airport;
    if (!changedAirport && manexUrl === current.manexUrl) return;
    airport = current.airport;
    manexUrl = current.manexUrl;
    if (available) loadAutomaticManex();
    if (!changedAirport) return;
    byId('ai-error').textContent = '';
    byId('ai-import-status').textContent = '';
    ask.elements.question.value = '';
    documents = [];
    renderDocuments();
    renderChat();
    if (available) loadDocuments();
  }
  function renderDocuments() {
    const container = byId('ai-documents');
    const selected = ask.elements.visual.value;
    container.replaceChildren();
    const choice = ask.elements.visual;
    choice.replaceChildren(new Option('Aucune',''));
    if (!documents.length) container.append(el('p','Aucun document importé pour ' + airport + '.','help'));
    for (const doc of documents) {
      const item = el('div',null,'ai-document');
      item.append(link(doc.title,doc.href),el('small',doc.category + ' · ' + doc.validity.label + ' · ' +
        doc.indexedPages + '/' + doc.pages + ' pages textuelles indexées'));
      if (doc.pdf) choice.append(new Option(doc.title,doc.id));
      container.append(item);
    }
    if (documents.some(doc => doc.id === selected)) choice.value = selected;
    updatePage();
  }
  function updatePage() {
    const doc = documents.find(item => item.id === ask.elements.visual.value);
    const page = ask.elements.page;
    page.disabled = !doc;
    page.max = doc?.pages ?? 1;
    if (!doc || Number(page.value) > doc.pages) page.value = '1';
  }
  async function loadDocuments() {
    const request = ++documentRequest;
    try {
      const result = await api('documents?airport=' + encodeURIComponent(airport));
      if (request !== documentRequest) return;
      documents = result;
      renderDocuments();
    } catch {
      if (request === documentRequest) byId('ai-import-status').textContent = 'Bibliothèque locale indisponible.';
    }
  }
  async function loadAutomaticManex() {
    const status = byId('ai-manex');
    const request = ++manexRequest;
    if (!manexUrl) {
      status.textContent = 'MANEX · Aucun lien connu pour ' + airport + '.';
      return;
    }
    status.textContent = 'MANEX · Lecture automatique pour ' + airport + '…';
    try {
      const query = new URLSearchParams({airport,url:manexUrl});
      const result = await api('manex?' + query);
      if (request !== manexRequest) return;
      status.replaceChildren();
      if (result) {
        status.append('MANEX IVAO · ',link(result.title,result.href),
          result.offline ? ' · Copie locale du ' + result.fetchedAt.slice(0,10) :
            result.revision ? ' · ' + result.revision : '');
      } else status.append('MANEX · Lecture automatique indisponible pour ce lien. ',link('Ouvrir le document',manexUrl));
    } catch {
      if (request !== manexRequest) return;
      status.replaceChildren('MANEX · Source momentanément inaccessible. ',link('Ouvrir le document',manexUrl));
    }
  }
  async function checkConnection() {
    const status = byId('ai-connection');
    try {
      if (location.protocol === 'file:') throw new Error('Mode fichier');
      const result = await api('status');
      available = true;
      configured = result.configured;
      provider = result.provider;
      visualAvailable = result.visual;
      webSearch = result.webSearch;
      status.textContent = provider === 'ollama' ? 'Moteur local Ollama configuré' :
        configured ? 'Synthèse OpenAI configurée' : 'Assistant local · Réponses documentaires';
      loadDocuments();
      loadAutomaticManex();
    } catch {
      available = false;
      configured = false;
      provider = 'documents';
      visualAvailable = false;
      webSearch = false;
      status.replaceChildren('Démarre le serveur local avec npm.cmd start, puis ouvre ');
      const local = el('a','E-Strips en local');
      local.href = 'http://127.0.0.1:4310/';
      status.append(local,'.');
      byId('ai-manex').textContent = '';
    }
    renderControls();
  }
  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded',String(open));
    document.body.classList.toggle('ai-open',open);
    if (open) {
      syncContext();
      checkConnection();
      poll = setInterval(syncContext,700);
      ask.elements.question.focus();
    } else {
      clearInterval(poll);
      toggle.focus();
    }
  }
  toggle.onclick = () => setOpen(panel.hidden);
  byId('ai-close').onclick = () => setOpen(false);
  panel.addEventListener('keydown',event => { if (event.key === 'Escape') setOpen(false); });
  ask.elements.visual.onchange = () => {
    ask.elements.page.value = '1';
    updatePage();
  };

  importer.onsubmit = async event => {
    event.preventDefault();
    if (!available || uploading) return;
    syncContext();
    const code = airport;
    const form = new FormData(importer);
    form.set('airport',code);
    uploading = true;
    renderControls();
    const status = byId('ai-import-status');
    status.textContent = 'Indexation en cours…';
    try {
      const doc = await api('documents',{method:'POST',body:form});
      if (airport === code) {
        importer.reset();
        status.textContent = doc.indexedPages ? 'Document indexé.' : 'Document ajouté. Sélectionne une page PDF pour la lecture visuelle.';
        await loadDocuments();
      }
    } catch (error) {
      if (airport === code) status.textContent = error.message;
    } finally { uploading = false; renderControls(); }
  };

  ask.onsubmit = async event => {
    event.preventDefault();
    if (!available || busy) return;
    const context = window.efsAssistantContext(configured && ask.elements.board.checked);
    const input = ask.elements.question;
    const question = input.value.trim();
    if (context.airport !== airport || context.manexUrl !== manexUrl) syncContext();
    const code = airport;
    if (!question) return;
    const visual = visualAvailable && ask.elements.visual.value ? {id:ask.elements.visual.value,page:Number(ask.elements.page.value)} : null;
    const payload = {question,context,online:ask.elements.online.checked,visual,
      history:history(code).slice(-8).map(({role,text}) => ({role,text}))};
    byId('ai-error').textContent = '';
    const user = {role:'user',text:question};
    const pending = el('p','Vérification des sources…','help');
    chat.append(message(user),pending);
    chat.scrollTop = chat.scrollHeight;
    input.value = '';
    busy = true;
    renderControls();
    try {
      const answer = await api('ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      history(code).push(user,{role:'assistant',text:answerText(answer),answer});
      saveHistory(code);
    } catch (error) {
      if (airport === code) {
        byId('ai-error').textContent = error.message;
        if (!input.value) input.value = question;
      }
    } finally {
      busy = false;
      renderControls();
      if (airport === code) renderChat();
    }
  };
  renderControls();
})();
