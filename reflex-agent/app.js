/**
 * REFLEX AGENT — Frontend Logic
 * Handles WebSocket connections, UI updates, Chart.js rendering, and Diff generation.
 */

document.addEventListener('DOMContentLoaded', () => {
    // ── DOM Elements ────────────────────────────────────────────────────────
    const UI = {
        codeInput: document.getElementById('codeInput'),
        lineCount: document.getElementById('lineCount'),
        languageSelect: document.getElementById('languageSelect'),
        modelSelect: document.getElementById('modelSelect'),
        btnStart: document.getElementById('btnStart'),
        statusPanel: document.getElementById('statusPanel'),
        statusIndicator: document.getElementById('statusIndicator'),
        statusText: document.getElementById('statusText'),
        loadingBar: document.getElementById('loadingBar'),
        resultsContainer: document.getElementById('resultsContainer'),
        emptyState: document.getElementById('emptyState'),
        finalScoreDisplay: document.getElementById('finalScoreDisplay'),
        radarChart: document.getElementById('radarChart'),
        btnReReview: document.getElementById('btnReReview'),
        btnDownloadCode: document.getElementById('btnDownloadCode'),
        btnDownloadReport: document.getElementById('btnDownloadReport'),
        roundTabs: document.getElementById('roundTabs'),
        timelineContainer: document.getElementById('timelineContainer'),
        settingsModal: document.getElementById('settingsModal'),
        btnSettings: document.getElementById('btnSettings'),
        btnCloseSettings: document.getElementById('btnCloseSettings'),
        btnSaveSettings: document.getElementById('btnSaveSettings'),
        apiKeyInput: document.getElementById('apiKeyInput'),
        toastContainer: document.getElementById('toastContainer'),
    };

    // ── State ───────────────────────────────────────────────────────────────
    let currentSessionId = null;
    let ws = null;
    let radarChartInstance = null;
    let sessionData = { rounds: [] };
    let currentActiveRound = 1;

    // ── Initialization ──────────────────────────────────────────────────────

    // Update line count
    UI.codeInput.addEventListener('input', () => {
        const lines = UI.codeInput.value.split('\n').length;
        UI.lineCount.textContent = `${lines} Line${lines !== 1 ? 's' : ''}`;
    });

    // Modals
    UI.btnSettings.addEventListener('click', () => UI.settingsModal.classList.add('open'));
    UI.btnCloseSettings.addEventListener('click', () => UI.settingsModal.classList.remove('open'));
    
    UI.btnSaveSettings.addEventListener('click', async () => {
        const apiKey = UI.apiKeyInput.value;
        const model = UI.modelSelect.value;
        
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: apiKey || null, model: model })
            });
            if (res.ok) {
                showToast('Settings saved successfully');
                UI.settingsModal.classList.remove('open');
            } else {
                showToast('Failed to save settings', 'error');
            }
        } catch (e) {
            showToast('Network error', 'error');
        }
    });

    // Start Review
    UI.btnStart.addEventListener('click', startReview);
    
    // Re-review
    UI.btnReReview.addEventListener('click', triggerReReview);

    // Downloads
    UI.btnDownloadCode.addEventListener('click', () => {
        if (!sessionData || !sessionData.current_code) return;
        const blob = new Blob([sessionData.current_code], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = getExtensionForLanguage(sessionData.language);
        a.download = `reflex_improved.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
    });

    UI.btnDownloadReport.addEventListener('click', () => {
        if (!currentSessionId) return;
        window.location.href = `/api/report/${currentSessionId}?format=html`;
    });

    // ── Core Functions ──────────────────────────────────────────────────────

    async function startReview() {
        const code = UI.codeInput.value.trim();
        if (!code) {
            showToast('Please enter some code to review', 'error');
            return;
        }

        const focusAreas = Array.from(document.querySelectorAll('.checkbox input:checked')).map(cb => cb.value);
        if (focusAreas.length === 0) {
            showToast('Select at least one focus area', 'error');
            return;
        }

        setStatus('running', 'Initializing Session...');
        UI.emptyState.classList.add('hidden');
        UI.resultsContainer.classList.remove('hidden');
        UI.timelineContainer.innerHTML = '';
        UI.roundTabs.innerHTML = '';
        
        // Reset chart
        if (radarChartInstance) {
            radarChartInstance.destroy();
            radarChartInstance = null;
        }
        UI.finalScoreDisplay.textContent = '--';
        UI.finalScoreDisplay.className = 'score-big';

        try {
            const res = await fetch('/api/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: code,
                    language: UI.languageSelect.value,
                    model: UI.modelSelect.value,
                    focus_areas: focusAreas
                })
            });
            
            const data = await res.json();
            if (res.ok) {
                currentSessionId = data.session_id;
                sessionData = { rounds: [] };
                connectWebSocket(currentSessionId);
            } else {
                setStatus('error', data.detail || 'Failed to start review');
                showToast(data.detail, 'error');
            }
        } catch (e) {
            setStatus('error', 'Network error');
            showToast('Network error', 'error');
        }
    }

    async function triggerReReview() {
        if (!currentSessionId) return;
        
        // Disable button during req
        UI.btnReReview.disabled = true;
        
        const focusAreas = Array.from(document.querySelectorAll('.checkbox input:checked')).map(cb => cb.value);
        
        try {
            const res = await fetch(`/api/re-review/${currentSessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: UI.modelSelect.value,
                    focus_areas: focusAreas,
                    code: UI.codeInput.value // Pass the current value of the editor
                })
            });
            
            const data = await res.json();
            if (res.ok) {
                setStatus('running', `Starting Round ${data.round}...`);
                UI.btnReReview.classList.add('hidden');
                // WS is already connected, it will just receive new messages
            } else {
                showToast(data.detail, 'error');
                UI.btnReReview.disabled = false;
            }
        } catch (e) {
            showToast('Network error', 'error');
            UI.btnReReview.disabled = false;
        }
    }

    // ── WebSocket ───────────────────────────────────────────────────────────

    function connectWebSocket(sessionId) {
        if (ws) {
            ws.close();
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws/${sessionId}`);

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleWebSocketMessage(msg);
        };

        ws.onclose = () => {
            console.log("WebSocket disconnected");
        };
    }

    function handleWebSocketMessage(msg) {
        if (msg.type === 'loop_start') {
            setStatus('running', `Round ${msg.round} - Loop ${msg.loop} Running...`);
            
            // Add skeleton card if it doesn't exist
            let cardId = `loop-${msg.round}-${msg.loop}`;
            if (!document.getElementById(cardId)) {
                ensureRoundTabExists(msg.round);
                if (currentActiveRound === msg.round) {
                    const skeleton = document.createElement('div');
                    skeleton.id = cardId;
                    skeleton.className = 'timeline__item';
                    skeleton.innerHTML = `
                        <div class="loop-card" style="opacity: 0.7;">
                            <div class="loop-card__header">
                                <div class="loop-card__title">Loop ${msg.loop}</div>
                                <div class="spinner"><span class="spinner__icon"></span> ANALYZING</div>
                            </div>
                        </div>
                    `;
                    UI.timelineContainer.appendChild(skeleton);
                    // Scroll to bottom
                    skeleton.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        } 
        else if (msg.type === 'loop_complete') {
            const loop = msg.loop;
            const round = msg.round;
            
            // Ensure we have place for it in sessionData
            if (!sessionData.rounds[round - 1]) {
                sessionData.rounds[round - 1] = { round_number: round, loops: [] };
            }
            // Update or add loop data
            const existingLoopIndex = sessionData.rounds[round-1].loops.findIndex(l => l.loop_number === loop.loop_number);
            if(existingLoopIndex >= 0) {
                 sessionData.rounds[round-1].loops[existingLoopIndex] = loop;
            } else {
                 sessionData.rounds[round-1].loops.push(loop);
            }
            
            // Update UI
            if (currentActiveRound === round) {
                renderLoopCard(round, loop);
                updateRadarChart(loop.axis_scores);
                updateScoreDisplay(loop.score.final_score);
            }
            
            // Update editor code with the latest
            UI.codeInput.value = loop.code_after;
            
        }
        else if (msg.type === 'round_complete') {
            setStatus('completed', `Round ${msg.round.round_number} Complete`);
            
            // Update full round data
            sessionData.rounds[msg.round.round_number - 1] = msg.round;
            sessionData.current_code = msg.round.final_code;
            
            // Show Re-Review button
            UI.btnReReview.classList.remove('hidden');
            UI.btnReReview.disabled = false;
        }
        else if (msg.type === 'error') {
            setStatus('error', `Error: ${msg.message}`);
            showToast(msg.message, 'error');
            UI.btnReReview.classList.remove('hidden');
            UI.btnReReview.disabled = false;
        }
    }

    // ── UI Rendering ────────────────────────────────────────────────────────

    function ensureRoundTabExists(roundNum) {
        let tab = document.getElementById(`tab-round-${roundNum}`);
        if (!tab) {
            tab = document.createElement('button');
            tab.id = `tab-round-${roundNum}`;
            tab.className = 'round-tab';
            tab.textContent = `ROUND ${roundNum}`;
            tab.onclick = () => switchRoundTab(roundNum);
            UI.roundTabs.appendChild(tab);
            
            // Automatically switch to new round tab if it's the latest
            switchRoundTab(roundNum);
        }
    }
    
    function switchRoundTab(roundNum) {
        currentActiveRound = roundNum;
        
        // Update tab styles
        document.querySelectorAll('.round-tab').forEach(t => t.classList.remove('active'));
        const activeTab = document.getElementById(`tab-round-${roundNum}`);
        if(activeTab) activeTab.classList.add('active');
        
        // Re-render timeline for this round
        UI.timelineContainer.innerHTML = '';
        const roundData = sessionData.rounds[roundNum - 1];
        if (roundData && roundData.loops) {
            roundData.loops.forEach(loop => {
                renderLoopCard(roundNum, loop);
            });
            
            // Update chart/score to final loop of this round
            if (roundData.loops.length > 0) {
                const lastLoop = roundData.loops[roundData.loops.length - 1];
                updateRadarChart(lastLoop.axis_scores);
                updateScoreDisplay(lastLoop.score.final_score);
            }
        }
    }

    function renderLoopCard(roundNum, loop) {
        let container = document.getElementById(`loop-${roundNum}-${loop.loop_number}`);
        if (!container) {
            container = document.createElement('div');
            container.id = `loop-${roundNum}-${loop.loop_number}`;
            container.className = 'timeline__item timeline__item--complete';
            UI.timelineContainer.appendChild(container);
        }

        const score = loop.score.final_score;
        let scoreClass = 'loop-card__score--high';
        let cardClass = 'loop-card--good';
        if (score < 8) { scoreClass = 'loop-card__score--mid'; cardClass = 'loop-card--warning'; }
        if (score < 5) { scoreClass = 'loop-card__score--low'; cardClass = 'loop-card--critical'; }

        // Count severities
        const counts = { critical: 0, major: 0, minor: 0, nitpick: 0 };
        loop.issues.forEach(i => {
            if (counts[i.severity] !== undefined) counts[i.severity]++;
        });

        let badgesHtml = '';
        if (counts.critical > 0) badgesHtml += `<div class="loop-card__issue-badge loop-card__issue-badge--critical">🔴 ${counts.critical} CRITICAL</div>`;
        if (counts.major > 0) badgesHtml += `<div class="loop-card__issue-badge loop-card__issue-badge--major">🟠 ${counts.major} MAJOR</div>`;
        if (counts.minor > 0) badgesHtml += `<div class="loop-card__issue-badge loop-card__issue-badge--minor">🟡 ${counts.minor} MINOR</div>`;
        if (counts.nitpick > 0) badgesHtml += `<div class="loop-card__issue-badge loop-card__issue-badge--nitpick">⚪ ${counts.nitpick} NITPICK</div>`;
        if (badgesHtml === '') badgesHtml = `<div class="loop-card__issue-badge" style="color: var(--success); border-color: var(--success);">✅ NO ISSUES</div>`;

        // Stopped reason
        let stoppedHtml = '';
        if (loop.stopped_reason) {
            stoppedHtml = `<div class="stopped-reason">${loop.stopped_reason}</div>`;
        }

        // Issues List
        let issuesListHtml = '<ul class="issue-list">';
        loop.issues.forEach(issue => {
            const linesStr = issue.lines && issue.lines.length > 0 ? `L${issue.lines.join(',')}` : '';
            issuesListHtml += `
                <li class="issue-item">
                    <div class="issue-item__severity loop-card__issue-badge--${issue.severity}">${issue.severity.substring(0,4)}</div>
                    <div class="issue-item__content">
                        <div class="issue-item__desc">${escapeHtml(issue.description)} <span class="issue-item__lines">${linesStr}</span></div>
                        <div class="issue-item__suggestion">${escapeHtml(issue.suggestion)}</div>
                    </div>
                </li>
            `;
        });
        issuesListHtml += '</ul>';

        // Diff viewer
        let diffHtml = '';
        if (loop.diff) {
            diffHtml = `
                <h4 style="margin: 15px 0 5px; font-size: 10px; color: var(--text-dim); text-transform: uppercase;">Changes Made</h4>
                <div class="diff-viewer">
                    ${renderDiff(loop.diff)}
                </div>
            `;
        }

        container.innerHTML = `
            <div class="loop-card ${cardClass}" onclick="this.querySelector('.loop-card__details').classList.toggle('open')">
                <div class="loop-card__header">
                    <div>
                        <div class="loop-card__title">Loop ${loop.loop_number}</div>
                        <div style="font-size: 9px; color: var(--text-muted); margin-top: 4px;">Click to expand</div>
                    </div>
                    <div class="loop-card__score ${scoreClass}">${score.toFixed(2)}</div>
                </div>
                <div class="loop-card__issues">
                    ${badgesHtml}
                </div>
                ${stoppedHtml}
                <div class="loop-card__details">
                    <h4 style="margin-bottom: 10px; font-size: 10px; color: var(--text-dim); text-transform: uppercase;">Issues Found</h4>
                    ${loop.issues.length > 0 ? issuesListHtml : '<p style="font-size: 11px; color: var(--success);">No issues found.</p>'}
                    ${diffHtml}
                </div>
            </div>
        `;
        
        // Scroll to bottom
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderDiff(diffText) {
        if (!diffText) return '';
        const lines = diffText.split('\n');
        let html = '';
        
        let oldLineNum = 0;
        let newLineNum = 0;

        lines.forEach(line => {
            if (line.startsWith('---') || line.startsWith('+++')) {
                html += `<div class="diff-line diff-line--header"><div class="diff-line__num"></div><div class="diff-line__content">${escapeHtml(line)}</div></div>`;
            } else if (line.startsWith('@@')) {
                // Parse line numbers from @@ -old,len +new,len @@
                const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                if (match) {
                    oldLineNum = parseInt(match[1]) - 1;
                    newLineNum = parseInt(match[2]) - 1;
                }
                html += `<div class="diff-line diff-line--header"><div class="diff-line__num"></div><div class="diff-line__content">${escapeHtml(line)}</div></div>`;
            } else if (line.startsWith('-')) {
                oldLineNum++;
                html += `<div class="diff-line diff-line--removed"><div class="diff-line__num">${oldLineNum}</div><div class="diff-line__content">${escapeHtml(line)}</div></div>`;
            } else if (line.startsWith('+')) {
                newLineNum++;
                html += `<div class="diff-line diff-line--added"><div class="diff-line__num">${newLineNum}</div><div class="diff-line__content">${escapeHtml(line)}</div></div>`;
            } else {
                oldLineNum++;
                newLineNum++;
                html += `<div class="diff-line diff-line--context"><div class="diff-line__num">${newLineNum}</div><div class="diff-line__content">${escapeHtml(line)}</div></div>`;
            }
        });
        
        return html;
    }

    // ── Radar Chart ─────────────────────────────────────────────────────────

    function updateRadarChart(axisScores) {
        const labels = [];
        const data = [];
        
        // Define fixed order
        const axes = ['correctness', 'performance', 'security', 'readability', 'robustness'];
        
        axes.forEach(axis => {
            labels.push(axis.toUpperCase());
            const scoreObj = axisScores.find(s => s.axis === axis);
            data.push(scoreObj ? scoreObj.score : 0);
        });

        if (radarChartInstance) {
            radarChartInstance.data.datasets[0].data = data;
            radarChartInstance.update();
            return;
        }

        const ctx = UI.radarChart.getContext('2d');
        
        // Chart.js global defaults for brutalist look
        Chart.defaults.color = '#B0B0B0';
        Chart.defaults.font.family = "'Space Mono', monospace";
        
        radarChartInstance = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Score',
                    data: data,
                    backgroundColor: 'rgba(0, 255, 65, 0.2)',
                    borderColor: '#00FF41',
                    borderWidth: 2,
                    pointBackgroundColor: '#0A0A0A',
                    pointBorderColor: '#00FF41',
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        pointLabels: {
                            color: '#00FF41',
                            font: { size: 9, family: "'Space Mono', monospace" }
                        },
                        ticks: {
                            display: false, // hide numbers on axis
                            min: 0,
                            max: 10,
                            stepSize: 2
                        },
                        backgroundColor: 'rgba(26, 26, 26, 0.5)'
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1A1A1A',
                        titleColor: '#00FF41',
                        bodyColor: '#B0B0B0',
                        borderColor: '#00FF41',
                        borderWidth: 1,
                        cornerRadius: 0,
                        displayColors: false,
                        callbacks: {
                            label: (context) => `${context.formattedValue}/10`
                        }
                    }
                }
            }
        });
    }

    function updateScoreDisplay(score) {
        UI.finalScoreDisplay.textContent = score.toFixed(2);
        
        UI.finalScoreDisplay.className = 'score-big';
        if (score >= 8.5) {
            UI.finalScoreDisplay.classList.add('score-big--high');
        } else if (score >= 6.0) {
            UI.finalScoreDisplay.classList.add('score-big--mid');
        } else {
            UI.finalScoreDisplay.classList.add('score-big--low');
        }
        
        // Add glitch animation briefly
        UI.finalScoreDisplay.classList.add('glitch');
        setTimeout(() => {
            UI.finalScoreDisplay.classList.remove('glitch');
        }, 1000);
    }

    // ── Utilities ───────────────────────────────────────────────────────────

    function setStatus(state, text) {
        UI.statusPanel.classList.remove('hidden');
        UI.statusIndicator.className = `status status--${state}`;
        UI.statusText.textContent = text;
        
        if (state === 'running') {
            UI.loadingBar.classList.remove('hidden');
            UI.btnStart.disabled = true;
        } else {
            UI.loadingBar.classList.add('hidden');
            UI.btnStart.disabled = false;
        }
    }

    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type === 'error' ? 'toast--error' : ''}`;
        toast.textContent = message;
        
        UI.toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function getExtensionForLanguage(lang) {
        const map = {
            'python': 'py',
            'javascript': 'js',
            'typescript': 'ts',
            'go': 'go',
            'rust': 'rs',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c'
        };
        return map[lang] || 'txt';
    }
});
