/**
 * @typedef {Object} ChatMessage
 * @property {string} [id]
 * @property {string|null} [parentId]
 * @property {string[]} [childrenIds]
 * @property {number} [timestamp]
 *
 * @typedef {Object} ChatHistory
 * @property {string} currentId
 * @property {Record<string, ChatMessage>} messages
 *
 * @typedef {Object} ChatItem
 * @property {Object} chat
 * @property {string} [chat.title]
 * @property {ChatHistory} [chat.history]
 * @property {ChatMessage[]} [chat.messages]
 */

const UI = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    actionBtn: document.getElementById('actionBtn'),
    statusDiv: document.getElementById('status'),
    statsDiv: document.getElementById('stats'),
    pruneMode: document.getElementById('pruneMode')
};

let appState = {
    parsedData: null,
    fileName: 'fixed_chat.json'
};

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker: Registered (Scope: ' + reg.scope + ')'))
            .catch(err => console.error('Service Worker: Registration failed:', err));
    });
}

// File Selection Events
UI.dropZone.addEventListener('click', () => UI.fileInput.click());
UI.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); UI.dropZone.classList.add('dragover'); });
UI.dropZone.addEventListener('dragleave', () => UI.dropZone.classList.remove('dragover'));
UI.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    UI.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
UI.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
});

// Action Button Event
UI.actionBtn.addEventListener('click', () => {
    if (!appState.parsedData) return;
    showStatus('Processing...', '');
    UI.actionBtn.disabled = true;

    try {
        const isPruneMode = UI.pruneMode.checked;
        const { cleanedData, logs } = processAllChats(appState.parsedData, isPruneMode);

        UI.statsDiv.innerHTML = logs.join('');
        UI.statsDiv.hidden = false;
        showStatus('Processing Complete! Downloading...', 'status-success');

        const suffix = isPruneMode ? '_clean.json' : '_repaired.json';
        downloadFile(cleanedData, appState.fileName.replace('.json', suffix));
    } catch (err) {
        console.error(err);
        showStatus('An error occurred during processing.', 'status-error');
    } finally {
        UI.actionBtn.disabled = false;
    }
});

function handleFile(file) {
    if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
        return showStatus('Please upload a valid JSON file.', 'status-error');
    }
    appState.fileName = file.name;
    showStatus('Reading file...', '');
    UI.actionBtn.disabled = true;
    UI.statsDiv.hidden = true;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            appState.parsedData = JSON.parse(event.target.result);
            showStatus(`Loaded "${file.name}". Ready to repair.`, 'status-success');
            UI.actionBtn.textContent = "Repair & Download JSON";
            UI.actionBtn.disabled = false;
        } catch (error) {
            showStatus('Error parsing JSON. Is the file valid?', 'status-error');
            appState.parsedData = null;
        }
    };
    reader.readAsText(file);
}

function processAllChats(data, pruneMode) {
    const logs = [];
    const inputData = Array.isArray(data) ? data : [data];
    const cleanedData = inputData.map((item, index) => processSingleChat(item, pruneMode, index, logs));
    return { cleanedData, logs };
}

function processSingleChat(item, pruneMode, index, globalLogs) {
    if (!item?.chat?.history?.messages) {
        globalLogs.push(`<div class="log-entry"><strong>Item ${index + 1}</strong>: Invalid structure</div>`);
        return item;
    }

    const chatTitle = item.chat.title || `Untitled Chat ${index + 1}`;
    const history = item.chat.history;

    // Modern deep clone
    let workingMessages = structuredClone(history.messages);
    const logDetails = [];

    const sanitizeResult = sanitizeGraph(workingMessages);
    if (sanitizeResult.brokenLinks > 0) logDetails.push(`Fixed ${sanitizeResult.brokenLinks} links`);

    const bestId = findBestCurrentId(history.currentId, workingMessages);
    let pointerFixed = (bestId !== history.currentId || !workingMessages[history.currentId]);
    if (pointerFixed) logDetails.push(`Restored pointer`);

    if (pruneMode) {
        const pruneResult = pruneUnusedBranches(workingMessages, bestId);
        workingMessages = pruneResult.messages;
        if (pruneResult.removedCount > 0) logDetails.push(`Pruned ${pruneResult.removedCount} nodes`);
    }

    const linearHistory = buildLinearHistory(workingMessages, bestId);

    let badges = [
        pointerFixed && `<span class="badge">Repaired</span>`,
        pruneMode && `<span class="badge">Pruned</span>`,
        sanitizeResult.brokenLinks > 0 && `<span class="badge">Sanitized</span>`
    ].filter(Boolean).join('');

    globalLogs.push(`
        <div class="log-entry">
            <strong>${escapeHtml(chatTitle)}</strong> ${badges || '<span class="badge">Healthy</span>'}
            <div style="color: #666; font-size: 0.8rem;">${logDetails.join(', ') || 'No issues found'}</div>
        </div>
    `);

    return {
        ...item,
        chat: {
            ...item.chat,
            messages: linearHistory,
            history: { ...history, currentId: bestId, messages: workingMessages }
        }
    };
}

/**
 * @param {string} rootId
 * @param {Record<string, ChatMessage>} messages
 * @param {function(string, ChatMessage): void} [visitorFn]
 * @returns {Set<string>}
 */
function traverseGraph(rootId, messages, visitorFn) {
    const queue = [rootId];
    const visited = new Set([rootId]);
    let head = 0;

    while (head < queue.length && head < 50000) {
        const currentId = queue[head++];
        const node = messages[currentId];

        if (visitorFn) visitorFn(currentId, node);

        for (const childId of (node?.childrenIds || [])) {
            if (!visited.has(childId) && messages[childId]) {
                visited.add(childId);
                queue.push(childId);
            }
        }
    }
    return visited;
}

function sanitizeGraph(messages) {
    let brokenLinks = 0;
    Object.values(messages).forEach(msg => {
        if (msg.childrenIds) {
            const originalLen = msg.childrenIds.length;
            msg.childrenIds = msg.childrenIds.filter(cid => messages[cid]);
            brokenLinks += (originalLen - msg.childrenIds.length);
        }
        if (msg.parentId && !messages[msg.parentId]) {
            msg.parentId = null;
            brokenLinks++;
        }
    });
    return { messages, brokenLinks };
}

function findBestCurrentId(currentId, messages) {
    const roots = Object.keys(messages).filter(id => !messages[id].parentId);
    if (roots.length === 0) return currentId;

    let bestRoot = roots[0];
    let maxBranchSize = -1;

    roots.forEach(rootId => {
        const branchNodes = traverseGraph(rootId, messages);
        if (branchNodes.size > maxBranchSize) {
            maxBranchSize = branchNodes.size;
            bestRoot = rootId;
        }
    });

    let bestLeaf = bestRoot;
    let latestTimestamp = -1;

    traverseGraph(bestRoot, messages, (id, node) => {
        if (node.timestamp > latestTimestamp) {
            latestTimestamp = node.timestamp;
            bestLeaf = id;
        }
    });

    return bestLeaf;
}

function pruneUnusedBranches(messages, leafId) {
    const kept = new Set();
    let p = leafId;
    while (p && messages[p]) {
        kept.add(p);
        p = messages[p].parentId;
    }

    const clean = {};
    kept.forEach(id => {
        const m = { ...messages[id] };
        if (m.childrenIds) m.childrenIds = m.childrenIds.filter(cid => kept.has(cid));
        clean[id] = m;
    });

    return { messages: clean, removedCount: Object.keys(messages).length - kept.size };
}

function buildLinearHistory(messages, leafId) {
    const history = [];
    let p = leafId;
    while (p && messages[p]) {
        history.unshift(messages[p]);
        p = messages[p].parentId;
    }
    return history;
}

function downloadFile(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function showStatus(msg, type) {
    UI.statusDiv.textContent = msg;
    UI.statusDiv.className = type;
    UI.statusDiv.hidden = false;
}

function escapeHtml(text) {
    return text?.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])) || text;
}