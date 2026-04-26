(function () {
  const MAX_SELECTED = 64;
  const state = {
    module: null,
    romFile: null,
    romBytes: null,
    chtFile: null,
    chtText: '',
    chtSource: '',
    cheatEntries: [],
    selected: new Set(),
    dirFiles: [],
    fonts: null,
    cheatMode: 'auto',
  };

  const el = {
    romFile: document.getElementById('romFile'),
    chtFile: document.getElementById('chtFile'),
    cheatDir: document.getElementById('cheatDir'),
    modeAuto: document.getElementById('modeAuto'),
    modeSingle: document.getElementById('modeSingle'),
    autoPick: document.getElementById('autoPick'),
    singlePick: document.getElementById('singlePick'),
    romInfo: document.getElementById('romInfo'),
    cheatInfo: document.getElementById('cheatInfo'),
    selectedInfo: document.getElementById('selectedInfo'),
    cheatPanel: document.getElementById('cheatPanel'),
    cheatList: document.getElementById('cheatList'),
    selectFirst: document.getElementById('selectFirst'),
    clearCheats: document.getElementById('clearCheats'),
    patchButton: document.getElementById('patchButton'),
    downloadLink: document.getElementById('downloadLink'),
    patchStatus: document.getElementById('patchStatus'),
    log: document.getElementById('log'),
  };

  function log(msg, isError) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    el.log.textContent += line;
    el.log.scrollTop = el.log.scrollHeight;
    if (isError) console.error(msg); else console.log(msg);
  }

  function setDownloadHidden() {
    if (el.downloadLink.href) URL.revokeObjectURL(el.downloadLink.href);
    el.downloadLink.removeAttribute('href');
    el.downloadLink.classList.add('hidden');
  }

  function setPatchStatus(kind, text) {
    el.patchStatus.className = `patch-status ${kind || ''}`.trim();
    el.patchStatus.textContent = text || '';
    el.patchStatus.classList.toggle('hidden', !text);
  }

  function clearCheatState(message) {
    state.chtFile = null;
    state.chtText = '';
    state.chtSource = '';
    state.cheatEntries = [];
    state.selected = new Set();
    renderCheats();
    if (message) log(message);
  }

  function setCheatControlsEnabled(enabled) {
    el.modeAuto.disabled = !enabled;
    el.modeSingle.disabled = !enabled;
    el.cheatDir.disabled = !enabled || state.cheatMode !== 'auto';
    el.chtFile.disabled = !enabled || state.cheatMode !== 'single';
  }

  function renderCheatMode() {
    el.modeAuto.checked = state.cheatMode === 'auto';
    el.modeSingle.checked = state.cheatMode === 'single';
    el.autoPick.classList.toggle('hidden', state.cheatMode !== 'auto');
    el.singlePick.classList.toggle('hidden', state.cheatMode !== 'single');
    setCheatControlsEnabled(!!state.romBytes);
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  function decodeText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      try {
        return new TextDecoder('gb18030').decode(bytes);
      } catch (e) {
        return new TextDecoder('gbk').decode(bytes);
      }
    }
  }

  function allocBytes(bytes) {
    const ptr = state.module._malloc(bytes.length || 1);
    if (bytes.length) heapU8().set(bytes, ptr);
    return ptr;
  }

  function heapU8() {
    if (!state.module || !state.module.HEAPU8) {
      throw new Error('WASM memory view is not available. Please rebuild with ./build-web.sh.');
    }
    return state.module.HEAPU8;
  }

  function freeAll(ptrs) {
    for (const ptr of ptrs) {
      if (ptr) state.module._free(ptr);
    }
  }

  function wasmString(ptr) {
    return ptr ? state.module.UTF8ToString(ptr) : '';
  }

  function wasmError() {
    return wasmString(state.module._wasm_last_error()) || 'unknown wasm error';
  }

  function gameIdFromRom(bytes) {
    if (!bytes || bytes.length < 0xB0) return 0;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getUint32(0xAC, true);
  }

  function pathOf(file) {
    return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  }

  function lowerPathOf(file) {
    return pathOf(file).toLowerCase();
  }

  function basenameOfPath(path) {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(idx + 1) : path;
  }

  function pathSegments(file) {
    return lowerPathOf(file).split('/').filter(Boolean);
  }

  function scoreIndexFile(file) {
    const segs = pathSegments(file);
    let score = 0;
    if (segs.includes('cheat')) score += 20;
    if (basenameOfPath(segs.join('/')) === 'gameid2cht.bin') score += 10;
    score -= segs.length;
    return score;
  }

  function scoreChtFile(file, decoded) {
    const segs = pathSegments(file);
    const base = segs[segs.length - 1] || '';
    if (base !== `${decoded.digits}.cht`) return -1;
    let score = 8;
    if (segs.includes('cheat')) score += 20;
    if (segs.includes(decoded.folder.toLowerCase())) score += 20;
    if (segs.includes('chn')) score += 12;
    if (segs.includes('eng')) score += 8;
    if (segs.length >= 2 && segs[segs.length - 2] === decoded.folder.toLowerCase()) score += 20;
    score -= segs.length;
    return score;
  }

  function bestByScore(files, scoreFn) {
    let best = null;
    let bestScore = -1;
    for (const file of files) {
      const score = scoreFn(file);
      if (score > bestScore) {
        best = file;
        bestScore = score;
      }
    }
    return bestScore >= 0 ? best : null;
  }

  function readIndexLookup(indexBytes, gameId) {
    const ptr = allocBytes(indexBytes);
    try {
      return state.module._wasm_lookup_cht_id(ptr, indexBytes.length, gameId) >>> 0;
    } finally {
      state.module._free(ptr);
    }
  }

  function decodeChtId(chtId) {
    const ptr = state.module._malloc(8);
    try {
      const num = state.module._wasm_decode_cht_digits(chtId >>> 0, ptr, 8);
      if (num < 0) return null;
      const digits = wasmString(ptr);
      if (!digits || digits.length !== 4) return null;
      const folder = wasmString(state.module._wasm_cht_folder_from_num(num));
      return { digits, num, folder };
    } finally {
      state.module._free(ptr);
    }
  }

  async function resolveChtFromDirectory(files, romBytes) {
    const gameId = gameIdFromRom(romBytes);
    const indexFile = bestByScore(files, (file) => {
      return basenameOfPath(lowerPathOf(file)) === 'gameid2cht.bin' ? scoreIndexFile(file) : -1;
    });
    if (!indexFile) throw new Error('EZ cheat 目录中没有找到 GameID2cht.bin。请选择 EZ/Omega 金手指合集根目录、CHEAT 目录，或改用单个 .cht 文件。');
    const indexBytes = new Uint8Array(await indexFile.arrayBuffer());
    const chtId = readIndexLookup(indexBytes, gameId);
    if (!chtId) throw new Error(`GameID ${gameId.toString(16).toUpperCase().padStart(8, '0')} 没有匹配的 EZ cheat 条目`);
    const decoded = decodeChtId(chtId);
    if (!decoded) throw new Error(`无法解码 EZ cheat id 0x${chtId.toString(16)}`);
    const chtFile = bestByScore(files, (file) => scoreChtFile(file, decoded));
    if (!chtFile) {
      const sameName = files.filter((file) => basenameOfPath(lowerPathOf(file)) === `${decoded.digits}.cht`).slice(0, 4).map(pathOf);
      const hint = sameName.length ? ` 找到同名文件但路径不标准: ${sameName.join(' | ')}` : '';
      throw new Error(`索引匹配 ${decoded.folder}/${decoded.digits}.cht，但目录中没有找到对应 Chn/Eng 文件。${hint}`);
    }
    const bytes = new Uint8Array(await chtFile.arrayBuffer());
    return { text: decodeText(bytes), source: pathOf(chtFile) };
  }

  function parseCheats(text, source) {
    const bytes = utf8Bytes(text);
    const ptr = allocBytes(bytes);
    try {
      if (!state.module._wasm_parse_cheats(ptr, bytes.length)) {
        throw new Error(wasmError());
      }
      const count = state.module._wasm_cheat_count() >>> 0;
      const entries = [];
      for (let i = 0; i < count; i++) {
        entries.push({
          index: i,
          name: wasmString(state.module._wasm_cheat_name(i)),
          opCount: state.module._wasm_cheat_op_count(i) >>> 0,
        });
      }
      state.chtText = text;
      state.chtSource = source;
      state.cheatEntries = entries;
      state.selected = new Set(entries.slice(0, Math.min(MAX_SELECTED, entries.length)).map((x) => x.index));
      renderCheats();
      log(`Cheat parsed: ${source}, entries ${entries.length}`);
    } finally {
      state.module._free(ptr);
    }
  }

  function renderCheats() {
    el.cheatList.textContent = '';
    if (!state.cheatEntries.length) {
      el.cheatPanel.classList.add('hidden');
      el.cheatInfo.textContent = state.chtSource ? `${state.chtSource}: 0 entries` : '未选择';
      updateSelectedInfo();
      return;
    }
    el.cheatPanel.classList.remove('hidden');
    const frag = document.createDocumentFragment();
    for (const entry of state.cheatEntries) {
      const row = document.createElement('label');
      row.className = 'cheat-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(entry.index);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (state.selected.size >= MAX_SELECTED) {
            cb.checked = false;
            log(`最多只能选择 ${MAX_SELECTED} 条金手指`, true);
            return;
          }
          state.selected.add(entry.index);
        } else {
          state.selected.delete(entry.index);
        }
        updateSelectedInfo();
      });
      const name = document.createElement('span');
      name.textContent = entry.name;
      const ops = document.createElement('small');
      ops.textContent = `${entry.opCount} writes`;
      row.append(cb, name, ops);
      frag.append(row);
    }
    el.cheatList.append(frag);
    el.cheatInfo.textContent = `${state.chtSource}: ${state.cheatEntries.length} entries`;
    updateSelectedInfo();
  }

  function updateSelectedInfo() {
    let writes = 0;
    for (const entry of state.cheatEntries) {
      if (state.selected.has(entry.index)) writes += entry.opCount;
    }
    el.selectedInfo.textContent = `${state.selected.size} / ${MAX_SELECTED}, writes ${writes}`;
    el.patchButton.disabled = !state.romBytes || !state.module;
  }

  async function loadFonts() {
    if (state.fonts) return state.fonts;
    const [zhRes, latinRes] = await Promise.all([
      fetch('fonts/fusion-pixel-8px-monospaced-zh_hans.bdf'),
      fetch('fonts/fusion-pixel-8px-monospaced-latin.bdf'),
    ]);
    if (!zhRes.ok || !latinRes.ok) throw new Error('无法加载 Web 字库。请先运行 build-web.sh 复制 fonts。');
    state.fonts = {
      zh: await zhRes.text(),
      latin: await latinRes.text(),
    };
    return state.fonts;
  }

  async function handleRomFile(file) {
    if (!file) return;
    setDownloadHidden();
    setPatchStatus('', '');
    clearCheatState('ROM changed: cheat selection cleared');
    el.chtFile.value = '';
    state.romFile = null;
    state.romBytes = null;
    renderCheatMode();

    const romBytes = new Uint8Array(await file.arrayBuffer());
    const ptr = allocBytes(romBytes);
    try {
      if (!state.module._wasm_get_rom_info(ptr, romBytes.length)) throw new Error(wasmError());
      const title = wasmString(state.module._wasm_rom_title()).replace(/\0/g, '');
      const code = wasmString(state.module._wasm_rom_game_code()).replace(/\0/g, '');
      const gameId = state.module._wasm_rom_game_id() >>> 0;
      state.romFile = file;
      state.romBytes = romBytes;
      el.romInfo.textContent = `${file.name} | ${title || 'NO TITLE'} | ${code} | ${gameId.toString(16).toUpperCase().padStart(8, '0')}`;
      log(`ROM loaded: ${file.name}`);
    } finally {
      state.module._free(ptr);
    }
    renderCheatMode();
    if (state.cheatMode === 'auto' && state.dirFiles.length) {
      try {
        await tryLoadDirectoryCheats();
        log('Existing EZ cheat directory rematched for the new ROM');
      } catch (err) {
        clearCheatState();
        log(err.message, true);
      }
    }
    updateSelectedInfo();
  }

  async function tryLoadDirectoryCheats() {
    if (!state.romBytes || !state.dirFiles.length) return;
    const resolved = await resolveChtFromDirectory(state.dirFiles, state.romBytes);
    parseCheats(resolved.text, resolved.source);
  }

  async function patchRom() {
    if (!state.module) {
      const msg = 'WASM core 还没加载完成，请稍等几秒后再试。';
      setPatchStatus('error', msg);
      alert(msg);
      return;
    }
    if (!state.romBytes) {
      const msg = 'ROM 没有加载。请重新选择 .gba 文件。';
      setPatchStatus('error', msg);
      alert(msg);
      return;
    }
    setDownloadHidden();
    setPatchStatus('busy', '正在打补丁，请稍等...');
    el.patchButton.disabled = true;
    const ptrs = [];
    try {
      let chtPtr = 0;
      let chtLen = 0;
      let zhPtr = 0;
      let zhLen = 0;
      let latinPtr = 0;
      let latinLen = 0;
      let selectedPtr = 0;
      const selected = Array.from(state.selected).sort((a, b) => a - b);

      if (selected.length > 0) {
        const fonts = await loadFonts();
        const chtBytes = utf8Bytes(state.chtText);
        const zhBytes = utf8Bytes(fonts.zh);
        const latinBytes = utf8Bytes(fonts.latin);
        chtPtr = allocBytes(chtBytes); ptrs.push(chtPtr); chtLen = chtBytes.length;
        zhPtr = allocBytes(zhBytes); ptrs.push(zhPtr); zhLen = zhBytes.length;
        latinPtr = allocBytes(latinBytes); ptrs.push(latinPtr); latinLen = latinBytes.length;
        const selectedU32 = new Uint32Array(selected);
        selectedPtr = allocBytes(new Uint8Array(selectedU32.buffer)); ptrs.push(selectedPtr);
      }

      const romPtr = allocBytes(state.romBytes); ptrs.push(romPtr);
      if (!state.module._wasm_patch_rom(romPtr, state.romBytes.length, chtPtr, chtLen,
                                        selectedPtr, selected.length, zhPtr, zhLen, latinPtr, latinLen)) {
        throw new Error(wasmError());
      }
      const outPtr = state.module._wasm_output_ptr();
      const outSize = state.module._wasm_output_size() >>> 0;
      const out = heapU8().slice(outPtr, outPtr + outSize);
      state.module._wasm_free_output();

      const blob = new Blob([out], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const name = state.romFile.name.replace(/\.gba$/i, '') + '_rts_keypad.gba';
      el.downloadLink.href = url;
      el.downloadLink.download = name;
      el.downloadLink.classList.remove('hidden');
      setPatchStatus('ok', `Patch 成功：${name}。请点击下载。`);
      log(`Patched: ${name}`);
      log(`Payload offset 0x${(state.module._wasm_patch_payload_offset() >>> 0).toString(16).toUpperCase()}, IRQ refs ${state.module._wasm_patch_irq_ref_count() >>> 0}, cheats ${state.module._wasm_patch_cheat_count() >>> 0}, writes ${state.module._wasm_patch_cheat_op_count() >>> 0}`);
    } catch (e) {
      setPatchStatus('error', `Patch 失败：${e.message}`);
      log(`Patch failed: ${e.message}`, true);
      alert(e.message);
    } finally {
      freeAll(ptrs);
      updateSelectedInfo();
    }
  }

  async function init() {
    if (typeof createPatcherModule !== 'function') {
      log('patcher_wasm.js 未加载。请先运行 ./build-web.sh 生成 WASM。', true);
      return;
    }
    el.romInfo.textContent = 'WASM 加载中...';
    state.module = await createPatcherModule();
    log('WASM core loaded');
    el.romFile.disabled = false;
    el.romInfo.textContent = '未选择';
    renderCheatMode();
    updateSelectedInfo();
  }

  el.romFile.addEventListener('change', (e) => handleRomFile(e.target.files[0]).catch((err) => {
    state.romFile = null;
    state.romBytes = null;
    el.romInfo.textContent = 'ROM 加载失败';
    renderCheatMode();
    updateSelectedInfo();
    log(err.message, true);
    alert(`ROM 加载失败: ${err.message}`);
  }));
  el.modeAuto.addEventListener('change', async () => {
    if (!el.modeAuto.checked) return;
    state.cheatMode = 'auto';
    clearCheatState('Cheat mode: auto match directory');
    renderCheatMode();
    if (state.romBytes && state.dirFiles.length) {
      try {
        await tryLoadDirectoryCheats();
      } catch (err) {
        log(err.message, true);
        alert(err.message);
      }
    }
  });
  el.modeSingle.addEventListener('change', async () => {
    if (!el.modeSingle.checked) return;
    state.cheatMode = 'single';
    clearCheatState('Cheat mode: single .cht file');
    renderCheatMode();
    if (el.chtFile.files && el.chtFile.files[0]) {
      const file = el.chtFile.files[0];
      const bytes = new Uint8Array(await file.arrayBuffer());
      parseCheats(decodeText(bytes), file.name);
    }
  });
  el.chtFile.addEventListener('change', async (e) => {
    if (state.cheatMode !== 'single') return;
    const file = e.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parseCheats(decodeText(bytes), file.name);
  });
  el.cheatDir.addEventListener('change', async (e) => {
    if (state.cheatMode !== 'auto') return;
    state.dirFiles = Array.from(e.target.files || []);
    log(`EZ cheat directory selected: ${state.dirFiles.length} files`);
    try {
      await tryLoadDirectoryCheats();
    } catch (err) {
      log(err.message, true);
      alert(err.message);
    }
  });
  el.selectFirst.addEventListener('click', () => {
    state.selected = new Set(state.cheatEntries.slice(0, Math.min(MAX_SELECTED, state.cheatEntries.length)).map((x) => x.index));
    renderCheats();
  });
  el.clearCheats.addEventListener('click', () => {
    state.selected.clear();
    renderCheats();
  });
  el.patchButton.addEventListener('click', patchRom);

  init().catch((err) => {
    state.module = null;
    el.romFile.disabled = true;
    el.romInfo.textContent = 'WASM 加载失败';
    log(`WASM core load failed: ${err.message}`, true);
    alert(`WASM 加载失败: ${err.message}`);
  });
})();
