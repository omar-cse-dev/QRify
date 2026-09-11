/**
 * QRify — Production Hardened, Fully Audited Studio Engine
 * Lead Developer: Omar Mohammad Chowdhury
 */

document.addEventListener('DOMContentLoaded', () => {
  // Service Worker Registration for Offline Capabilities
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('Service Worker registration skipped or failed:', err);
    });
  }

  // ==========================================
  // STATE & UTILITIES
  // ==========================================
  const STATE = {
    currentCategory: 'url',
    qrCode: null,
    scanHistory: safeJSONParse(localStorage.getItem('qrify_scan_history'), []),
    genHistory: safeJSONParse(localStorage.getItem('qrify_gen_history'), []),
    exportCount: parseInt(localStorage.getItem('qrify_export_count') || '0', 10),
    scannerInstance: null,
    scannerActive: false,
    availableCameras: [],
    currentCameraIndex: 0,
    torchState: false,
    currentScanResult: null,
    bulkData: [],
    bulkHeaders: [],
    logoBase64: null,
    deferredInstallPrompt: null,
    sessionScanEvents: [],
    lastScannedPayload: null,
    lastScanTimestamp: 0
  };

  const MAX_HISTORY_ITEMS = 50;
  const FIXED_MARGIN = 8;
  const MAX_BULK_ROWS = 1000;
  const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB limit
  const SCAN_DEBOUNCE_MS = 2500; // Cooldown to prevent spam duplicate scans

  function safeJSONParse(str, fallback) {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeVCard(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  function escapeWiFi(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/:/g, '\\:').replace(/,/g, '\\,');
  }

  function safeSaveStorage(key, value) {
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        showToast('Storage full. Cleaning up old history records...', 'info');
        STATE.genHistory = STATE.genHistory.slice(0, 20);
        STATE.scanHistory = STATE.scanHistory.slice(0, 20);
        try {
          localStorage.setItem('qrify_gen_history', JSON.stringify(STATE.genHistory));
          localStorage.setItem('qrify_scan_history', JSON.stringify(STATE.scanHistory));
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        } catch (retryErr) {
          console.error('Storage retry failed:', retryErr);
        }
      }
    }
  }

  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard', 'success');
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) showToast('Copied to clipboard', 'success');
      else showToast('Failed to copy text', 'error');
    } catch (err) {
      showToast('Copy command failed', 'error');
    }
    document.body.removeChild(textArea);
  }

  function isValidURL(string) {
    try {
      const u = new URL(string);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function isVCard(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    return clean.startsWith('BEGIN:VCARD') && clean.includes('END:VCARD');
  }

  function downloadVCard(vcardData) {
    if (!vcardData) return;
    const blob = new Blob([vcardData], { type: 'text/vcard;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `contact_${Date.now()}.vcf`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('vCard contact file downloaded', 'success');
  }

  function getLuminance(hex) {
    const cleanHex = hex.replace('#', '');
    const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
    const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
    const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
    const a = [r, g, b].map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }

  function checkScanSafety(fgHex, bgHex) {
    const lum1 = getLuminance(fgHex);
    const lum2 = getLuminance(bgHex);
    const ratio = (Math.max(lum1, lum2) + 0.05) / (Math.min(lum1, lum2) + 0.05);
    return ratio >= 3.0;
  }

  const CATEGORIES = {
    url: {
      label: 'Website URL',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
      desc: 'Links to any webpage',
      fields: [{ id: 'url', label: 'URL', type: 'url', placeholder: 'https://example.com', required: true }]
    },
    wifi: {
      label: 'Wi‑Fi Network',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>',
      desc: 'Auto connect to Wi-Fi',
      fields: [
        { id: 'ssid', label: 'Network Name (SSID)', type: 'text', placeholder: 'My Home Network', required: true },
        { id: 'password', label: 'Password', type: 'password', placeholder: 'Network password' },
        {
          id: 'encryption', label: 'Security', type: 'select',
          options: [{ label: 'WPA/WPA2/WPA3', value: 'WPA' }, { label: 'WEP', value: 'WEP' }, { label: 'None (Open)', value: 'nopass' }]
        },
        { id: 'hidden', label: 'Hidden Network', type: 'checkbox' }
      ]
    },
    vcard: {
      label: 'vCard Contact',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
      desc: 'Save contact details',
      fields: [
        { id: 'firstName', label: 'First Name', type: 'text', placeholder: 'John', required: true },
        { id: 'lastName', label: 'Last Name', type: 'text', placeholder: 'Doe' },
        { id: 'phone', label: 'Phone', type: 'tel', placeholder: '+1 234 567 8900' },
        { id: 'email', label: 'Email', type: 'email', placeholder: 'john@example.com' },
        { id: 'org', label: 'Organization / Company', type: 'text', placeholder: 'Acme Inc.' },
        { id: 'title', label: 'Job Title', type: 'text', placeholder: 'Software Engineer' },
        { id: 'address', label: 'Street Address', type: 'text', placeholder: '123 Tech Lane, CA' },
        { id: 'website', label: 'Website URL', type: 'url', placeholder: 'https://example.com' },
        { id: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Additional contact notes...' }
      ]
    },
    text: {
      label: 'Plain Text',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
      desc: 'Raw text payload',
      fields: [{ id: 'text', label: 'Text Content', type: 'textarea', placeholder: 'Type anything...', required: true }]
    },
    email: {
      label: 'Email',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>',
      desc: 'Send formatted email',
      fields: [
        { id: 'to', label: 'Recipient Email', type: 'email', placeholder: 'hello@example.com', required: true },
        { id: 'subject', label: 'Subject', type: 'text', placeholder: 'Inquiry' },
        { id: 'body', label: 'Body Text', type: 'textarea', placeholder: 'Email message...' }
      ]
    },
    phone: {
      label: 'Phone Call',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>',
      desc: 'Direct phone number',
      fields: [{ id: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+1234567890', required: true }]
    },
    sms: {
      label: 'SMS Text',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
      desc: 'Pre-filled text message',
      fields: [
        { id: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+1234567890', required: true },
        { id: 'message', label: 'Message', type: 'textarea', placeholder: 'Type your message...' }
      ]
    },
    geo: {
      label: 'Location',
      icon: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
      desc: 'Coordinates on map',
      fields: [
        { id: 'lat', label: 'Latitude', type: 'text', placeholder: '37.7749', required: true },
        { id: 'lng', label: 'Longitude', type: 'text', placeholder: '-122.4194', required: true }
      ]
    }
  };

  function showToast(message, type = 'info') {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    wrap.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  document.addEventListener('click', (e) => {
    const target = e.target.closest('.ripple');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const circle = document.createElement('span');
    const diameter = Math.max(rect.width, rect.height);
    const radius = diameter / 2;
    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${e.clientX - rect.left - radius}px`;
    circle.style.top = `${e.clientY - rect.top - radius}px`;
    circle.classList.add('ripple-effect');
    const existing = target.querySelector('.ripple-effect');
    if (existing) existing.remove();
    target.appendChild(circle);
  });

  // ==========================================
  // NAVIGATION & THEME
  // ==========================================
  const navBtns = document.querySelectorAll('.nav-btn');
  const views = document.querySelectorAll('.view');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const viewTarget = btn.getAttribute('data-view');
      
      if (viewTarget !== 'scanner' && STATE.scannerActive) {
        stopCamera();
      }

      navBtns.forEach(b => b.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      const targetEl = document.getElementById(`view-${viewTarget}`);
      if (targetEl) targetEl.classList.add('active');

      if (viewTarget === 'analytics') renderAnalytics();
      if (viewTarget === 'history') renderHistory();
    });
  });

  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      themeBtn.textContent = newTheme === 'dark' ? '🌙' : '☀️';
      safeSaveStorage('qrify_theme', newTheme);
    });
  }

  if (localStorage.getItem('qrify_theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (themeBtn) themeBtn.textContent = '🌙';
  }

  // Network status feedback (toast-based, no layout changes)
  let lastNetworkToastAt = 0;
  function notifyNetworkState(message, type) {
    const now = Date.now();
    if (now - lastNetworkToastAt < 1200) return;
    lastNetworkToastAt = now;
    showToast(message, type);
  }
  window.addEventListener('offline', () => notifyNetworkState('You are offline. QRify will keep local tools available where possible.', 'info'));
  window.addEventListener('online', () => notifyNetworkState('Back online. Connection restored.', 'success'));

  // Lightweight scan success feedback: haptic + short beep.
  let scanAudioContext = null;
  function playScanBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!scanAudioContext) scanAudioContext = new AudioCtx();
      if (scanAudioContext.state === 'suspended') scanAudioContext.resume().catch(() => {});
      const osc = scanAudioContext.createOscillator();
      const gain = scanAudioContext.createGain();
      const now = scanAudioContext.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
      osc.connect(gain).connect(scanAudioContext.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    } catch (e) {}
  }

  function triggerScanFeedback() {
    try {
      if (typeof navigator.vibrate === 'function') navigator.vibrate([45, 25, 45]);
    } catch (e) {}
    playScanBeep();
  }

  const installBtn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    STATE.deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!STATE.deferredInstallPrompt) return;
      STATE.deferredInstallPrompt.prompt();
      const choice = await STATE.deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        installBtn.hidden = true;
      }
      STATE.deferredInstallPrompt = null;
    });
  }

  const presetBtns = document.querySelectorAll('#colorPresets .preset-btn');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const fg = btn.getAttribute('data-fg');
      const bg = btn.getAttribute('data-bg');
      const eye = btn.getAttribute('data-eye');

      if (fg) document.getElementById('fgColor').value = fg;
      if (bg) document.getElementById('bgColor').value = bg;
      if (eye) document.getElementById('eyeColor').value = eye;

      updateQrCode();
    });
  });

  ['fgColor', 'bgColor', 'eyeColor'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        presetBtns.forEach(b => b.classList.remove('active'));
        updateQrCode();
      });
    }
  });

  const printQrBtn = document.getElementById('printQrBtn');
  if (printQrBtn) {
    printQrBtn.addEventListener('click', () => {
      const payload = buildPayload();
      if (!payload) return showToast('Please complete required fields first', 'error');
      window.print();
    });
  }

  function formatSmartUrl(val) {
    if (!val) return '';
    let clean = val.trim();
    if (!clean) return '';
    if (!/^(https?:\/\/|mailto:|tel:|sms:|geo:)/i.test(clean)) {
      clean = 'https://' + clean;
    }
    return clean;
  }

  // ==========================================
  // QR GENERATOR ENGINE
  // ==========================================
  function renderCategories() {
    const grid = document.getElementById('categoryGrid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.keys(CATEGORIES).forEach(key => {
      const cat = CATEGORIES[key];
      const btn = document.createElement('button');
      btn.className = `cat ${key === STATE.currentCategory ? 'active' : ''}`;
      btn.setAttribute('aria-label', `Select ${cat.label}`);
      btn.innerHTML = `
        ${cat.icon}
        <strong>${cat.label}</strong>
        <small>${cat.desc}</small>
      `;
      btn.addEventListener('click', () => {
        STATE.currentCategory = key;
        renderCategories();
        renderDynamicForm();
        updateQrCode();
      });
      grid.appendChild(btn);
    });
  }

  function renderDynamicForm() {
    const formContainer = document.getElementById('dynamicForm');
    if (!formContainer) return;
    const cat = CATEGORIES[STATE.currentCategory];
    formContainer.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'form-grid';

    cat.fields.forEach(f => {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = `field ${f.type === 'textarea' ? 'full' : ''}`;
      
      const fieldId = `field_${f.id}`;
      const label = document.createElement('label');
      label.setAttribute('for', fieldId);
      label.textContent = f.label + (f.required ? ' *' : '');
      fieldDiv.appendChild(label);

      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          input.appendChild(o);
        });
      } else if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.placeholder = f.placeholder || '';
      } else if (f.type === 'checkbox') {
        const toggleDiv = document.createElement('div');
        toggleDiv.className = 'inline-toggle';
        toggleDiv.innerHTML = `
          <strong style="font-size:12px">${f.label}</strong>
          <label class="switch">
            <input type="checkbox" id="${fieldId}" aria-label="${f.label}">
            <span class="slider"></span>
          </label>
        `;
        fieldDiv.innerHTML = '';
        fieldDiv.appendChild(toggleDiv);
        grid.appendChild(fieldDiv);

        const chk = toggleDiv.querySelector('input');
        if (chk) chk.addEventListener('change', updateQrCode);
        return;
      } else {
        input = document.createElement('input');
        input.type = f.type;
        input.placeholder = f.placeholder || '';
      }

      input.id = fieldId;
      if (f.required) input.setAttribute('required', 'true');
      input.addEventListener('input', updateQrCode);
      fieldDiv.appendChild(input);
      grid.appendChild(fieldDiv);
    });

    formContainer.appendChild(grid);
  }

  function validateRequiredFields() {
    const cat = CATEGORIES[STATE.currentCategory];
    for (const f of cat.fields) {
      if (f.required) {
        const el = document.getElementById(`field_${f.id}`);
        if (!el || !el.value.trim()) return false;
      }
    }
    return true;
  }

  function buildPayload() {
    if (!validateRequiredFields()) return '';
    const cat = STATE.currentCategory;
    let payload = '';

    if (cat === 'url') {
      const val = document.getElementById('field_url')?.value || '';
      payload = val ? formatSmartUrl(val) : '';
    } else if (cat === 'wifi') {
      const ssid = document.getElementById('field_ssid')?.value.trim() || '';
      const pass = document.getElementById('field_password')?.value || '';
      const enc = document.getElementById('field_encryption')?.value || 'WPA';
      const hidden = document.getElementById('field_hidden')?.checked || false;
      if (ssid) {
        payload = `WIFI:S:${escapeWiFi(ssid)};T:${enc};P:${escapeWiFi(pass)};H:${hidden ? 'true' : 'false'};;`;
      }
    } else if (cat === 'vcard') {
      const fn = document.getElementById('field_firstName')?.value.trim() || '';
      const ln = document.getElementById('field_lastName')?.value.trim() || '';
      const phone = document.getElementById('field_phone')?.value.trim() || '';
      const email = document.getElementById('field_email')?.value.trim() || '';
      const org = document.getElementById('field_org')?.value.trim() || '';
      const title = document.getElementById('field_title')?.value.trim() || '';
      const address = document.getElementById('field_address')?.value.trim() || '';
      const website = document.getElementById('field_website')?.value.trim() || '';
      const notes = document.getElementById('field_notes')?.value.trim() || '';

      const displayName = `${fn} ${ln}`.trim() || fn || 'Contact';

      if (fn || ln || phone || email || org || title || address || website || notes) {
        let card = `BEGIN:VCARD\nVERSION:3.0\nN:${escapeVCard(ln)};${escapeVCard(fn)};;;\nFN:${escapeVCard(displayName)}`;
        if (org) card += `\nORG:${escapeVCard(org)}`;
        if (title) card += `\nTITLE:${escapeVCard(title)}`;
        if (phone) card += `\nTEL:${escapeVCard(phone)}`;
        if (email) card += `\nEMAIL:${escapeVCard(email)}`;
        if (address) card += `\nADR:;;${escapeVCard(address)};;;;`;
        if (website) card += `\nURL:${escapeVCard(formatSmartUrl(website))}`;
        if (notes) card += `\nNOTE:${escapeVCard(notes)}`;
        card += '\nEND:VCARD';
        payload = card;
      }
    } else if (cat === 'text') {
      payload = document.getElementById('field_text')?.value || '';
    } else if (cat === 'email') {
      const to = document.getElementById('field_to')?.value.trim() || '';
      const sub = encodeURIComponent(document.getElementById('field_subject')?.value || '');
      const body = encodeURIComponent(document.getElementById('field_body')?.value || '');
      if (to) {
        payload = `mailto:${to}?subject=${sub}&body=${body}`;
      }
    } else if (cat === 'phone') {
      const num = document.getElementById('field_phone')?.value.trim() || '';
      if (num) payload = `tel:${num}`;
    } else if (cat === 'sms') {
      const num = document.getElementById('field_phone')?.value.trim() || '';
      const msg = encodeURIComponent(document.getElementById('field_message')?.value || '');
      if (num) payload = `sms:${num}?body=${msg}`;
    } else if (cat === 'geo') {
      const latVal = document.getElementById('field_lat')?.value.trim();
      const lngVal = document.getElementById('field_lng')?.value.trim();
      
      if (latVal && lngVal) {
        const lat = parseFloat(latVal);
        const lng = parseFloat(lngVal);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          payload = `geo:${lat},${lng}`;
        }
      }
    }

    return payload;
  }

  function getQrStylingOptions(payload) {
    const fgColor = document.getElementById('fgColor')?.value || '#111827';
    const bgColor = document.getElementById('bgColor')?.value || '#ffffff';
    const eyeColor = document.getElementById('eyeColor')?.value || '#4f46e5';
    const dotType = document.getElementById('dotType')?.value || 'square';
    const eyeType = document.getElementById('eyeType')?.value || 'square';
    let ecLevel = document.getElementById('ecLevel')?.value || 'M';
    const gradientMode = document.querySelector('#gradientSeg button.active')?.getAttribute('data-value') || 'none';

    if (STATE.logoBase64 && (ecLevel === 'L' || ecLevel === 'M')) {
      ecLevel = 'Q';
    }

    let dotsOptions = { color: fgColor, type: dotType };

    if (gradientMode !== 'none') {
      dotsOptions.gradient = {
        type: gradientMode,
        rotation: 0,
        colorStops: [
          { offset: 0, color: fgColor },
          { offset: 1, color: eyeColor }
        ]
      };
    }

    return {
      width: 320,
      height: 320,
      type: 'canvas',
      data: payload,
      margin: FIXED_MARGIN,
      qrOptions: { errorCorrectionLevel: ecLevel },
      dotsOptions: dotsOptions,
      backgroundOptions: { color: bgColor },
      cornersSquareOptions: { color: eyeColor, type: eyeType },
      cornersDotOptions: { color: eyeColor },
      image: STATE.logoBase64 || undefined,
      imageOptions: { hideBackgroundDots: true, imageSize: 0.35, margin: 4 }
    };
  }

  function updateQrCode() {
    const payload = buildPayload();
    const charCount = document.getElementById('charCount');
    if (charCount) charCount.textContent = `${payload.length} chars`;

    const fgColor = document.getElementById('fgColor')?.value || '#111827';
    const bgColor = document.getElementById('bgColor')?.value || '#ffffff';
    const contrastChip = document.getElementById('contrastWarningChip');
    
    if (contrastChip) {
      const isScanSafe = checkScanSafety(fgColor, bgColor);
      contrastChip.style.display = isScanSafe ? 'none' : 'inline-block';
    }

    const container = document.getElementById('qr-preview');
    if (!container) return;
    
    container.innerHTML = '';
    STATE.qrCode = null;

    if (!payload) {
      container.innerHTML = '<div class="empty">Enter required information to generate preview</div>';
      const statusChip = document.getElementById('statusChip');
      if (statusChip) statusChip.textContent = 'Awaiting input';
      return;
    }

    const options = getQrStylingOptions(payload);

    if (typeof QRCodeStyling !== 'undefined') {
      try {
        STATE.qrCode = new QRCodeStyling(options);
        STATE.qrCode.append(container);
      } catch (err) {
        console.error('QRCodeStyling render error:', err);
      }
    } else {
      container.innerHTML = '<div class="empty">QR Generator library unavailable.</div>';
    }

    const statusChip = document.getElementById('statusChip');
    if (statusChip) statusChip.textContent = 'Live';
  }

  ['fgColor', 'bgColor', 'eyeColor', 'dotType', 'eyeType', 'ecLevel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateQrCode);
  });

  const gradSegBtns = document.querySelectorAll('#gradientSeg button');
  gradSegBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      gradSegBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateQrCode();
    });
  });

  const logoFile = document.getElementById('logoFile');
  const removeLogoBtn = document.getElementById('removeLogoBtn');
  
  if (logoFile) {
    logoFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        if (!file.type.startsWith('image/')) {
          return showToast('Please select a valid image file', 'error');
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          return showToast('Logo image must be smaller than 5MB', 'error');
        }
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          if (img.width > 2500 || img.height > 2500) {
            return showToast('Image dimensions are too high (max 2500x2500px)', 'error');
          }
          const r = new FileReader();
          r.onload = (evt) => {
            STATE.logoBase64 = evt.target.result;
            if (removeLogoBtn) removeLogoBtn.style.display = 'inline-block';
            updateQrCode();
            showToast('Center logo updated', 'success');
          };
          r.readAsDataURL(file);
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          showToast('Malformed or unreadable image file', 'error');
        };
        img.src = objectUrl;
      }
    });
  }

  if (removeLogoBtn) {
    removeLogoBtn.addEventListener('click', () => {
      STATE.logoBase64 = null;
      if (logoFile) logoFile.value = '';
      removeLogoBtn.style.display = 'none';
      updateQrCode();
      showToast('Logo removed', 'info');
    });
  }

  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      const payload = buildPayload();
      if (!payload) return showToast('Please fill in required fields before exporting', 'error');
      const fmt = btn.getAttribute('data-export');
      if (!STATE.qrCode) return showToast('QR Code not ready', 'error');
      try {
        STATE.qrCode.download({ name: `qrify-${Date.now()}`, extension: fmt });
        STATE.exportCount++;
        safeSaveStorage('qrify_export_count', STATE.exportCount.toString());
        showToast(`Exported as ${fmt.toUpperCase()}`, 'success');
      } catch (e) {
        showToast('Export failed', 'error');
      }
    });
  });

  const saveQrBtn = document.getElementById('saveQrBtn');
  if (saveQrBtn) {
    saveQrBtn.addEventListener('click', () => {
      const payload = buildPayload();
      if (!payload) return showToast('Please fill in required fields before saving', 'error');
      const record = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        type: 'Generated',
        category: STATE.currentCategory,
        value: payload
      };
      STATE.genHistory.unshift(record);
      if (STATE.genHistory.length > MAX_HISTORY_ITEMS) {
        STATE.genHistory = STATE.genHistory.slice(0, MAX_HISTORY_ITEMS);
      }
      safeSaveStorage('qrify_gen_history', STATE.genHistory);
      showToast('Saved to local history', 'success');
    });
  }

  const shareQrBtn = document.getElementById('shareQrBtn');
  if (shareQrBtn) {
    shareQrBtn.addEventListener('click', async () => {
      const payload = buildPayload();
      if (!payload) return showToast('Please fill in required fields to share', 'error');
      const shareTitle = 'QRify — Premium QR Studio';
      const shareText = `QRify QR code\n${payload}`;

      try {
        if (STATE.qrCode && typeof STATE.qrCode.getRawData === 'function') {
          const blob = await STATE.qrCode.getRawData('png');
          if (blob && navigator.share && navigator.canShare) {
            const file = new File([blob], 'qrify-qr.png', { type: blob.type || 'image/png' });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ title: shareTitle, text: 'Generated with QRify', files: [file] });
              showToast('QR code shared', 'success');
              return;
            }
          }
        }
        if (navigator.share) {
          await navigator.share({ title: shareTitle, text: shareText });
          showToast('QR result shared', 'success');
        } else {
          copyToClipboard(payload);
          showToast('Sharing is not supported here. QR data copied instead.', 'info');
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        showToast('Unable to share from this browser', 'error');
      }
    });
  }

  const copyQrDataBtn = document.getElementById('copyQrDataBtn');
  if (copyQrDataBtn) {
    copyQrDataBtn.addEventListener('click', () => {
      const payload = buildPayload();
      if (payload) {
        copyToClipboard(payload);
      } else {
        showToast('Please fill in required fields to copy data', 'error');
      }
    });
  }

  // ==========================================
  // CAMERA & FILE SCANNER
  // ==========================================
  const startScanBtn = document.getElementById('startScanBtn');
  const switchCameraBtn = document.getElementById('switchCameraBtn');
  const torchBtn = document.getElementById('torchBtn');

  function initScanner() {
    if (typeof Html5Qrcode === 'undefined') {
      showToast('Scanner library not loaded', 'error');
      return false;
    }
    if (!STATE.scannerInstance) {
      STATE.scannerInstance = new Html5Qrcode("reader");
    }
    return true;
  }

  async function loadCameras() {
    if (typeof Html5Qrcode === 'undefined') return;
    try {
      const devices = await Html5Qrcode.getCameras();
      if (devices && devices.length > 0) {
        STATE.availableCameras = devices;
      }
    } catch (e) {
      console.warn('Could not enumerate cameras:', e);
    }
  }

  async function startCamera() {
    if (!initScanner()) return;
    try {
      if (STATE.availableCameras.length === 0) {
        await loadCameras();
      }

      let cameraConfig;
      if (STATE.availableCameras.length > 0) {
        const cam = STATE.availableCameras[STATE.currentCameraIndex % STATE.availableCameras.length];
        cameraConfig = { deviceId: { exact: cam.id } };
      } else {
        cameraConfig = { facingMode: "environment" };
      }

      await STATE.scannerInstance.start(
        cameraConfig,
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onScanSuccess
      );
      
      STATE.scannerActive = true;
      if (startScanBtn) startScanBtn.textContent = 'Stop camera';
      const statusEl = document.getElementById('cameraStatus');
      if (statusEl) statusEl.textContent = 'Camera active, scanning...';
      
      addSessionTimelineEvent('Started camera scanner');
    } catch (err) {
      showToast('Could not access camera', 'error');
      console.error(err);
    }
  }

  async function stopCamera() {
    if (STATE.scannerInstance && STATE.scannerActive) {
      try {
        await STATE.scannerInstance.stop();
      } catch (e) {
        console.warn('Scanner stop warning:', e);
      } finally {
        STATE.scannerActive = false;
        if (startScanBtn) startScanBtn.textContent = 'Start camera';
        const statusEl = document.getElementById('cameraStatus');
        if (statusEl) statusEl.textContent = 'Camera is idle.';
        STATE.torchState = false;
        
        const videoElem = document.querySelector('#reader video');
        if (videoElem && videoElem.srcObject) {
          const stream = videoElem.srcObject;
          const tracks = stream.getTracks();
          tracks.forEach(track => {
            if (track.getCapabilities && track.getCapabilities().torch) {
              track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }
            track.stop();
          });
          videoElem.srcObject = null;
        }

        addSessionTimelineEvent('Stopped camera scanner');
      }
    }
  }

  if (startScanBtn) {
    startScanBtn.addEventListener('click', () => {
      if (STATE.scannerActive) {
        stopCamera();
      } else {
        startCamera();
      }
    });
  }

  if (switchCameraBtn) {
    switchCameraBtn.addEventListener('click', async () => {
      if (STATE.availableCameras.length > 1) {
        STATE.currentCameraIndex = (STATE.currentCameraIndex + 1) % STATE.availableCameras.length;
        if (STATE.scannerActive) {
          await stopCamera();
          await startCamera();
        }
        showToast(`Switched to ${STATE.availableCameras[STATE.currentCameraIndex].label || 'camera'}`, 'info');
      } else if (STATE.scannerActive) {
        await stopCamera();
        await startCamera();
      }
    });
  }

  if (torchBtn) {
    torchBtn.addEventListener('click', async () => {
      if (!STATE.scannerActive || !STATE.scannerInstance) {
        return showToast('Camera is not active', 'error');
      }
      try {
        const videoElem = document.querySelector('#reader video');
        if (videoElem && videoElem.srcObject) {
          const track = videoElem.srcObject.getVideoTracks()[0];
          const capabilities = track.getCapabilities ? track.getCapabilities() : {};
          if (capabilities.torch) {
            STATE.torchState = !STATE.torchState;
            await track.applyConstraints({
              advanced: [{ torch: STATE.torchState }]
            });
            showToast(`Torch ${STATE.torchState ? 'ON' : 'OFF'}`, 'success');
          } else {
            showToast('Torch not supported on this device', 'error');
          }
        } else {
          showToast('Video track unavailable', 'error');
        }
      } catch (e) {
        showToast('Torch operation failed', 'error');
      }
    });
  }

  function handleDecodedPayload(text) {
    let parsedText = text;
    try {
      const parsedObj = JSON.parse(text);
      if (parsedObj && typeof parsedObj === 'object') {
        if (parsedObj.data) {
          parsedText = parsedObj.data;
        } else {
          parsedText = JSON.stringify(parsedObj, null, 2);
        }
      }
    } catch (_) {}
    return parsedText;
  }

  function detectPayloadType(payload) {
    if (!payload) return 'text';
    const clean = payload.trim();
    if (/^https?:\/\//i.test(clean)) return 'url';
    if (/^mailto:/i.test(clean)) return 'mailto';
    if (/^tel:/i.test(clean)) return 'tel';
    if (/^sms:/i.test(clean)) return 'sms';
    if (/^geo:/i.test(clean)) return 'geo';
    if (isVCard(clean)) return 'vcard';
    return 'text';
  }

  function updateScanActionButtons(payload) {
    const type = detectPayloadType(payload);
    const openBtns = [document.getElementById('openResultBtn'), document.getElementById('modalOpenBtn')];
    
    openBtns.forEach(btn => {
      if (!btn) return;
      if (type === 'url') {
        btn.textContent = 'Open Website';
        btn.hidden = false;
      } else if (type === 'mailto') {
        btn.textContent = 'Send Email';
        btn.hidden = false;
      } else if (type === 'tel') {
        btn.textContent = 'Call Phone';
        btn.hidden = false;
      } else if (type === 'sms') {
        btn.textContent = 'Send Message';
        btn.hidden = false;
      } else if (type === 'geo') {
        btn.textContent = 'Open Map';
        btn.hidden = false;
      } else {
        btn.textContent = 'Open / Action';
        btn.hidden = type === 'text' || type === 'vcard';
      }
    });
  }

  function executeScanAction(payload) {
    if (!payload) return;
    const type = detectPayloadType(payload);
    const clean = payload.trim();

    if (type === 'url') {
      const url = formatSmartUrl(clean);
      if (isValidURL(url)) window.open(url, '_blank', 'noopener,noreferrer');
      else showToast('Invalid URL format', 'error');
    } else if (type === 'mailto' || type === 'tel' || type === 'sms' || type === 'geo') {
      window.location.href = clean;
    } else if (type === 'vcard') {
      downloadVCard(clean);
    } else {
      copyToClipboard(clean);
    }
  }

  function onScanSuccess(decodedText) {
    const now = Date.now();
    const finalContent = handleDecodedPayload(decodedText);

    if (finalContent === STATE.lastScannedPayload && (now - STATE.lastScanTimestamp) < SCAN_DEBOUNCE_MS) {
      return;
    }

    STATE.lastScannedPayload = finalContent;
    STATE.lastScanTimestamp = now;
    STATE.currentScanResult = finalContent;
    triggerScanFeedback();

    const record = {
      id: now,
      timestamp: new Date().toISOString(),
      type: 'Scanned',
      category: isVCard(finalContent) ? 'vCard Contact' : detectPayloadType(finalContent).toUpperCase(),
      value: finalContent
    };

    STATE.scanHistory.unshift(record);
    if (STATE.scanHistory.length > MAX_HISTORY_ITEMS) {
      STATE.scanHistory = STATE.scanHistory.slice(0, MAX_HISTORY_ITEMS);
    }
    safeSaveStorage('qrify_scan_history', STATE.scanHistory);

    const resultPanel = document.getElementById('scanResultPanel');
    const resultEmpty = document.getElementById('scanResultEmpty');
    const resultText = document.getElementById('scanResultText');
    const scanMeta = document.getElementById('scanMeta');
    const saveContactBtn = document.getElementById('saveContactBtn');

    if (resultPanel && resultEmpty && resultText) {
      resultEmpty.hidden = true;
      resultPanel.hidden = false;
      resultText.textContent = finalContent;
    }

    updateScanActionButtons(finalContent);

    if (saveContactBtn) {
      saveContactBtn.hidden = !isVCard(finalContent);
    }

    if (scanMeta) scanMeta.textContent = `${STATE.scanHistory.length} scans`;

    addSessionTimelineEvent(`Scanned payload (${finalContent.length} chars)`);
    openModal(finalContent);
  }

  const scanImageFile = document.getElementById('scanImageFile');
  if (scanImageFile) {
    scanImageFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return showToast('File size exceeds maximum limit of 5MB', 'error');
      }
      if (!initScanner()) return;
      try {
        const res = await STATE.scannerInstance.scanFile(file, true);
        onScanSuccess(res);
      } catch (err) {
        showToast('No valid QR code found in image', 'error');
      }
    });
  }

  // Accessible Modal System
  const modal = document.getElementById('resultModal');
  const closeModalBtn = document.getElementById('closeModal');
  const modalText = document.getElementById('modalResultText');
  const modalVcardBtn = document.getElementById('modalVcardBtn');
  let previouslyFocusedElement = null;

  function openModal(text) {
    previouslyFocusedElement = document.activeElement;
    if (modalText) modalText.textContent = text;
    if (modalVcardBtn) modalVcardBtn.hidden = !isVCard(text);
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      closeModalBtn?.focus();
    }
  }

  function closeModal() {
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (previouslyFocusedElement) previouslyFocusedElement.focus();
    }
  }

  if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeModal();
    }
  });

  ['openResultBtn', 'modalOpenBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        if (!STATE.currentScanResult) return;
        executeScanAction(STATE.currentScanResult);
      });
    }
  });

  ['copyResultBtn', 'modalCopyBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        if (STATE.currentScanResult) {
          copyToClipboard(STATE.currentScanResult);
        }
      });
    }
  });

  const saveContactBtn = document.getElementById('saveContactBtn');
  if (saveContactBtn) {
    saveContactBtn.addEventListener('click', () => {
      if (isVCard(STATE.currentScanResult)) {
        downloadVCard(STATE.currentScanResult);
      }
    });
  }

  if (modalVcardBtn) {
    modalVcardBtn.addEventListener('click', () => {
      if (isVCard(STATE.currentScanResult)) {
        downloadVCard(STATE.currentScanResult);
      }
    });
  }

  function addSessionTimelineEvent(description) {
    STATE.sessionScanEvents.unshift({
      time: new Date().toLocaleTimeString(),
      desc: description
    });
    renderSessionTimeline();
  }

  function renderSessionTimeline() {
    const container = document.getElementById('sessionTimeline');
    if (!container) return;
    if (STATE.sessionScanEvents.length === 0) {
      container.innerHTML = '<div class="empty">No session activity yet.</div>';
      return;
    }
    container.innerHTML = STATE.sessionScanEvents.slice(0, 5).map(ev => `
      <div class="timeline-item">
        <span>${escapeHTML(ev.desc)}</span>
        <strong>${escapeHTML(ev.time)}</strong>
      </div>
    `).join('');
  }

  // ==========================================
  // BULK GENERATOR (ASYNC WORKER LOOP)
  // ==========================================
  const bulkFile = document.getElementById('bulkFile');
  const bulkColumnSelect = document.getElementById('bulkColumn');
  const generateBulkBtn = document.getElementById('generateBulkBtn');

  if (bulkFile) {
    bulkFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (file.size > MAX_FILE_SIZE_BYTES) {
        showToast('File size exceeds maximum limit of 5MB', 'error');
        bulkFile.value = '';
        return;
      }

      if (typeof XLSX === 'undefined') {
        return showToast('Spreadsheet parsing library not available', 'error');
      }

      const reader = new FileReader();
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

      reader.onload = (evt) => {
        try {
          const data = evt.target.result;
          let workbook;
          if (ext === '.csv') {
            workbook = XLSX.read(data, { type: 'string' });
          } else {
            workbook = XLSX.read(data, { type: 'array' });
          }
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

          if (json.length > 0) {
            STATE.bulkHeaders = json[0] || [];
            STATE.bulkData = json.slice(1).filter(row => row.some(cell => String(cell).trim() !== ''));

            if (STATE.bulkData.length > MAX_BULK_ROWS) {
              showToast(`Limiting dataset to first ${MAX_BULK_ROWS} rows to prevent memory overload.`, 'info');
              STATE.bulkData = STATE.bulkData.slice(0, MAX_BULK_ROWS);
            }

            populateBulkColumns();
            renderBulkPreview();
            const countChip = document.getElementById('bulkCount');
            if (countChip) countChip.textContent = `${STATE.bulkData.length} rows`;
            showToast(`Loaded ${STATE.bulkData.length} rows successfully`, 'success');
          } else {
            showToast('File contains no rows', 'error');
          }
        } catch (err) {
          showToast('Failed to parse spreadsheet file', 'error');
        }
      };

      if (ext === '.csv') {
        reader.readAsText(file);
      } else {
        reader.readAsArrayBuffer(file);
      }
    });
  }

  function populateBulkColumns() {
    if (!bulkColumnSelect) return;
    bulkColumnSelect.innerHTML = '';
    
    if (STATE.bulkHeaders.length === 0) {
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '0';
      defaultOpt.textContent = 'Column 1';
      bulkColumnSelect.appendChild(defaultOpt);
      return;
    }

    STATE.bulkHeaders.forEach((h, idx) => {
      const opt = document.createElement('option');
      opt.value = idx.toString();
      opt.textContent = h ? String(h).trim() : `Column ${idx + 1}`;
      bulkColumnSelect.appendChild(opt);
    });
  }

  function renderBulkPreview() {
    const wrap = document.getElementById('bulkPreview');
    if (!wrap) return;
    if (STATE.bulkData.length === 0) {
      wrap.innerHTML = '<div class="empty">No bulk data loaded.</div>';
      return;
    }

    let html = '<table class="table"><thead><tr>';
    STATE.bulkHeaders.forEach(h => html += `<th>${escapeHTML(String(h || ''))}</th>`);
    html += '</tr></thead><tbody>';

    STATE.bulkData.slice(0, 5).forEach(row => {
      html += '<tr>';
      STATE.bulkHeaders.forEach((_, colIdx) => {
        html += `<td>${row[colIdx] !== undefined ? escapeHTML(String(row[colIdx])) : ''}</td>`;
      });
      html += '</tr>';
    });

    html += '</tbody></table>';
    if (STATE.bulkData.length > 5) {
      html += `<div class="small muted" style="padding:8px">...and ${STATE.bulkData.length - 5} more rows</div>`;
    }
    wrap.innerHTML = html;
  }

  if (generateBulkBtn) {
    generateBulkBtn.addEventListener('click', async () => {
      if (STATE.bulkData.length === 0) return showToast('Upload a valid CSV/Excel file first', 'error');
      if (typeof JSZip === 'undefined') return showToast('JSZip library not loaded', 'error');
      if (typeof QRCodeStyling === 'undefined') return showToast('QRCodeStyling library not loaded', 'error');

      const colIdx = parseInt(bulkColumnSelect.value || '0', 10);
      const fmtSeg = document.querySelector('#bulkFormatSeg button.active');
      const ext = fmtSeg ? fmtSeg.getAttribute('data-value') : 'png';

      const zip = new JSZip();
      const folder = zip.folder('qr_codes');
      const progressBar = document.getElementById('bulkProgressBar');
      const progressText = document.getElementById('bulkProgressText');

      generateBulkBtn.disabled = true;
      let generatedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      try {
        for (let i = 0; i < STATE.bulkData.length; i++) {
          const val = String(STATE.bulkData[i][colIdx] || '').trim();
          if (!val) {
            skippedCount++;
            continue;
          }

          try {
            const options = getQrStylingOptions(val);
            const qrTemp = new QRCodeStyling(options);
            const blob = await qrTemp.getRawData(ext);

            if (blob) {
              folder.file(`qr_${i + 1}.${ext}`, blob);
              generatedCount++;
            } else {
              failedCount++;
            }
          } catch (rowErr) {
            failedCount++;
            console.error(`Row ${i + 1} processing error:`, rowErr);
          }

          const pct = Math.round(((i + 1) / STATE.bulkData.length) * 100);
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (progressText) progressText.textContent = `Processing ${i + 1} of ${STATE.bulkData.length}...`;

          if (i % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        if (generatedCount > 0) {
          const zipContent = await zip.generateAsync({ type: 'blob' });
          const downloadUrl = URL.createObjectURL(zipContent);
          
          const link = document.createElement('a');
          link.href = downloadUrl;
          link.download = `qrify_bulk_qrs.zip`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          
          setTimeout(() => {
            URL.revokeObjectURL(downloadUrl);
          }, 1000);
        }

        if (progressText) progressText.textContent = `Done! Generated: ${generatedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`;
        showToast(`Bulk processing complete (${generatedCount} QRs)`, generatedCount > 0 ? 'success' : 'error');
      } catch (err) {
        console.error('Bulk generation failed:', err);
        showToast('Error generating bulk ZIP archive', 'error');
      } finally {
        generateBulkBtn.disabled = false;
      }
    });
  }

  const bulkSegBtns = document.querySelectorAll('#bulkFormatSeg button');
  bulkSegBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      bulkSegBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ==========================================
  // LOCAL ANALYTICS
  // ==========================================
  function renderAnalytics() {
    const statGen = document.getElementById('statGenerated');
    const statScan = document.getElementById('statScanned');
    const statSess = document.getElementById('statSessions');
    const statForm = document.getElementById('statFormats');

    if (statGen) statGen.textContent = STATE.genHistory.length;
    if (statScan) statScan.textContent = STATE.scanHistory.length;
    
    const uniqueSessionDates = new Set(
      STATE.scanHistory.map(item => new Date(item.timestamp).toDateString())
    );
    if (statSess) statSess.textContent = uniqueSessionDates.size;
    if (statForm) statForm.textContent = STATE.exportCount;

    const catMix = document.getElementById('categoryMix');
    if (catMix) {
      const counts = {};
      STATE.genHistory.forEach(item => {
        counts[item.category] = (counts[item.category] || 0) + 1;
      });
      let html = '';
      Object.keys(counts).forEach(k => {
        html += `<div class="timeline-item"><span>${escapeHTML(k.toUpperCase())}</span><strong>${counts[k]}</strong></div>`;
      });
      catMix.innerHTML = html || '<div class="empty">No generated QR data recorded.</div>';
    }
  }

  // ==========================================
  // PERSISTENT HISTORY
  // ==========================================
  function renderHistory() {
    const tbody = document.getElementById('historyBody');
    const sub = document.getElementById('historySub');
    if (!tbody) return;

    const all = [...STATE.genHistory, ...STATE.scanHistory].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (sub) sub.textContent = `${all.length} events`;

    if (all.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No activity recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    all.forEach(item => {
      const tr = document.createElement('tr');
      
      const tdTime = document.createElement('td');
      tdTime.textContent = new Date(item.timestamp).toLocaleString();
      
      const tdType = document.createElement('td');
      tdType.innerHTML = `<span class="chip">${escapeHTML(item.type)}</span>`;
      
      const tdCat = document.createElement('td');
      tdCat.textContent = item.category;
      
      const tdVal = document.createElement('td');
      tdVal.style.cssText = 'max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      tdVal.textContent = item.value;
      
      const tdAct = document.createElement('td');
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn small';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy value');
      copyBtn.addEventListener('click', () => copyToClipboard(item.value));
      tdAct.appendChild(copyBtn);

      tr.appendChild(tdTime);
      tr.appendChild(tdType);
      tr.appendChild(tdCat);
      tr.appendChild(tdVal);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    });
  }

  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all local activity history?')) {
        STATE.genHistory = [];
        STATE.scanHistory = [];
        localStorage.removeItem('qrify_gen_history');
        localStorage.removeItem('qrify_scan_history');
        renderHistory();
        renderAnalytics();
        showToast('History cleared successfully', 'success');
      }
    });
  }

  // ==========================================
  // APP INITIALIZATION
  // ==========================================
  renderCategories();
  renderDynamicForm();
  updateQrCode();
  renderSessionTimeline();
  loadCameras();
});