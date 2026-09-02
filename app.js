/**
* @typedef {Object} ChatMessage
* @property {string} [id]
* @property {string|null} [parentId]
* @property {string[]} [childrenIds]
* @property {number} [timestamp]
* @property {string} [role]
* @property {any} [content]
* @property {any[]} [files]
* @property {any[]} [output]
* @property {string} [text]
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
        const isPruneMode = UI.pruneMode ? UI.pruneMode.checked : false;
        const { cleanedData, logs } = processAllChats(appState.parsedData, isPruneMode);

        UI.statsDiv.innerHTML = logs.join('');
        UI.statsDiv.hidden = false;
        showStatus('Processing Complete! Downloading...', 'status-success');

        const suffix = isPruneMode ? '_clean.json' : '_repaired.json';
        downloadFile(cleanedData, appState.fileName.replace(/\.json$/i, '') + suffix);
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
    const isArray = Array.isArray(data);
    const inputData = isArray ? data : [data];
    const cleanedData = inputData.map((item, index) => processSingleChat(item, pruneMode, index, logs));
    return { cleanedData: isArray ? cleanedData : cleanedData[0], logs };
}

/**
* Extracts plain text content from various message schema variations
*/
function extractMessageText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .map(part => (typeof part === 'string' ? part : part?.text || ''))
            .join('\n');
    }
    if (Array.isArray(msg.output)) {
        const textParts = [];
        for (const out of msg.output) {
            if (out?.content && Array.isArray(out.content)) {
                for (const c of out.content) {
                    if (c?.text) textParts.push(c.text);
                }
            }
        }
        if (textParts.length > 0) return textParts.join('\n');
    }
    return typeof msg.text === 'string' ? msg.text : '';
}

/**
* Enforces strict User -> Assistant alternation:
* - Consecutive User messages: Keep the LAST message
* - Consecutive Assistant messages: Keep the FIRST message
*/
function enforceAlternatingRoles(linearMessages) {
    // 1. Filter out completely empty ghost nodes (no text & no attachments)
    const validMessages = [];
    for (const msg of linearMessages) {
        const text = extractMessageText(msg).trim();
        const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
        if (text || hasFiles) {
            const role = (msg.role === 'assistant' || msg.role === 'model') ? 'assistant' : 'user';
            validMessages.push({ ...msg, role });
        }
    }

    if (validMessages.length === 0) return [];

    // 2. Group consecutive messages by role
    const groups = [];
    let currentGroup = [validMessages[0]];

    for (let i = 1; i < validMessages.length; i++) {
        const msg = validMessages[i];
        if (msg.role === currentGroup[0].role) {
            currentGroup.push(msg);
        } else {
            groups.push(currentGroup);
            currentGroup = [msg];
        }
    }
    groups.push(currentGroup);

    // 3. Apply selection rules:
    //    - 'user' group: pick the LAST message
    //    - 'assistant' group: pick the FIRST message
    const alternating = [];
    for (const group of groups) {
        if (group[0].role === 'user') {
            alternating.push(group[group.length - 1]);
        } else {
            alternating.push(group[0]);
        }
    }

    // 4. Ensure the conversation starts with 'user'
    while (alternating.length > 0 && alternating[0].role !== 'user') {
        alternating.shift();
    }

    return alternating;
}

/**
* Reconstructs clean linear tree pointers (parentId / childrenIds)
*/
function rebuildTreeFromLinear(linearMessages) {
    const messagesObj = {};

    for (let i = 0; i < linearMessages.length; i++) {
        const current = { ...linearMessages[i] };
        if (!current.id) {
            current.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : 'msg_' + Math.random().toString(36).substring(2, 9);
        }

        const prevId = i > 0 ? linearMessages[i - 1].id : null;
        const nextId = i < linearMessages.length - 1 ? linearMessages[i + 1].id : null;

        current.parentId = prevId;
        current.childrenIds = nextId ? [nextId] : [];

        messagesObj[current.id] = current;
    }

    const currentId = linearMessages.length > 0 ? linearMessages[linearMessages.length - 1].id : null;
    return { messagesObj, currentId };
}

function processSingleChat(item, pruneMode, index, globalLogs) {
    if (!item?.chat?.history?.messages) {
        globalLogs.push(`<div class="log-entry"><strong>Item ${index + 1}</strong>: Invalid structure</div>`);
        return item;
    }

    const chatTitle = item.chat.title || `Untitled Chat ${index + 1}`;
    const history = item.chat.history;
    let workingMessages = structuredClone(history.messages);
    const logDetails = [];

    // 1. Sanitize graph links (fixes broken/missing parent-child pointers)
    const sanitizeResult = sanitizeGraph(workingMessages);
    if (sanitizeResult.brokenLinks > 0) {
        logDetails.push(`Fixed ${sanitizeResult.brokenLinks} broken links`);
    }

    // 2. Trace the active leaf node
    const bestId = findBestCurrentId(history.currentId, workingMessages);
    if (bestId !== history.currentId) {
        logDetails.push(`Restored active thread pointer`);
    }

    // 3. Extract the active linear branch path from leaf back to root
    const rawLinear = [];
    let p = bestId;
    while (p && workingMessages[p]) {
        rawLinear.unshift(workingMessages[p]);
        p = workingMessages[p].parentId;
    }

    // 4. Enforce strict alternation & filter ghost nodes on active path
    const alternatingLinear = enforceAlternatingRoles(rawLinear);
    const removedCount = rawLinear.length - alternatingLinear.length;
    if (removedCount > 0) {
        logDetails.push(`Cleaned ${removedCount} redundant/ghost turns`);
    }

    let finalMessagesObj;
    let finalCurrentId;

    // 5. Apply branch handling based on pruneMode
    if (pruneMode) {
        // Flatten the tree: discard alternate branches, keep ONLY the active path
        const rebuilt = rebuildTreeFromLinear(alternatingLinear);
        finalMessagesObj = rebuilt.messagesObj;
        finalCurrentId = rebuilt.currentId;
        const totalNodes = Object.keys(workingMessages).length;
        const keptNodes = Object.keys(finalMessagesObj).length;
        if (totalNodes > keptNodes) {
            logDetails.push(`Pruned ${totalNodes - keptNodes} branch nodes`);
        }
    } else {
        // Preserve tree: keep all alternate branches, forks, and history
        finalMessagesObj = workingMessages;
        finalCurrentId = bestId;
    }

    const badges = [
        pruneMode ? '<span class="badge">Flattened / Pruned</span>' : '<span class="badge">Branches Preserved</span>',
        sanitizeResult.brokenLinks > 0 ? '<span class="badge">Sanitized</span>' : ''
    ].filter(Boolean).join(' ');

    globalLogs.push(`
        <div class="log-entry">
            <strong>${escapeHtml(chatTitle)}</strong> ${badges}
            <div style="color: #666; font-size: 0.8rem;">${logDetails.join(', ') || 'Clean'}</div>
        </div>
    `);

    return {
        ...item,
        chat: {
            ...item.chat,
            messages: alternatingLinear, // Linear alternating sequence for API / direct list view
            history: {
                ...history,
                currentId: finalCurrentId,
                messages: finalMessagesObj // Full tree (pruneMode=false) or linear tree (pruneMode=true)
            }
        }
    };
}

/**
* @param {string} rootId
* @param {Record<string, ChatMessage>} messages
* @param {function(string, ChatMessage, number): void} [visitorFn]
* @returns {Set<string>}
*/
function traverseGraph(rootId, messages, visitorFn) {
    const queue = [{ id: rootId, depth: 0 }];
    const visited = new Set([rootId]);
    let head = 0;

    while (head < queue.length && head < 50000) {
        const { id: currentId, depth } = queue[head++];
        const node = messages[currentId];

        if (visitorFn) visitorFn(currentId, node, depth);

        for (const childId of (node?.childrenIds || [])) {
            if (!visited.has(childId) && messages[childId]) {
                visited.add(childId);
                queue.push({ id: childId, depth: depth + 1 });
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
    // 1. If existing currentId is valid and exists, prioritize it
    if (currentId && messages[currentId]) return currentId;

    const roots = Object.keys(messages).filter(id => !messages[id].parentId);
    if (roots.length === 0) {
        const keys = Object.keys(messages);
        return keys.length > 0 ? keys[0] : null;
    }

    // 2. Find the largest connected component
    let bestRoot = roots[0];
    let maxBranchSize = -1;

    roots.forEach(rootId => {
        const branchNodes = traverseGraph(rootId, messages);
        if (branchNodes.size > maxBranchSize) {
            maxBranchSize = branchNodes.size;
            bestRoot = rootId;
        }
    });

    // 3. Find the best leaf node (latest timestamp or deepest leaf node)
    let bestLeaf = bestRoot;
    let maxTimestamp = -1;
    let maxDepth = -1;

    traverseGraph(bestRoot, messages, (id, node, depth) => {
        const ts = typeof node?.timestamp === 'number' ? node.timestamp : -1;
        if (ts > maxTimestamp) {
            maxTimestamp = ts;
            bestLeaf = id;
        } else if (maxTimestamp === -1 && depth > maxDepth) {
            maxDepth = depth;
            bestLeaf = id;
        }
    });

    return bestLeaf;
}

function downloadFile(data, filename) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showStatus(msg, type) {
    UI.statusDiv.textContent = msg;
    UI.statusDiv.className = type;
    UI.statusDiv.hidden = false;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": "&#39;" }[m]));
}
