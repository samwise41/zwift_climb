// ==========================================
// js/ui.js - Ride Logic, UI Rendering & Charts
// ==========================================

window.addEventListener('beforeunload', function (e) {
    if (startTime) { e.preventDefault(); e.returnValue = ''; }
});

function openHelp() { document.getElementById('helpModal').style.display = 'block'; document.getElementById('modalBackdrop').style.display = 'block'; }
function closeHelp() { document.getElementById('helpModal').style.display = 'none'; document.getElementById('modalBackdrop').style.display = 'none'; }

function toggleSettings() {
    const box = document.getElementById('data-settings-box');
    const btn = document.getElementById('toggleSettingsBtn');
    if (box.style.display === 'none') {
        box.style.display = 'flex';
        btn.innerHTML = '▼ Hide Settings';
    } else {
        box.style.display = 'none';
        btn.innerHTML = '▶ Show Settings';
    }
}

function toggleCockpitMode() {
    isCockpitMode = !isCockpitMode;
    const body = document.body;
    const btn = document.getElementById('cockpitToggleBtn');
    
    if (isCockpitMode) {
        body.classList.add('cockpit-mode');
        btn.innerHTML = '❌ Exit Cockpit';
        btn.style.position = 'fixed';
        btn.style.top = '10px';
        btn.style.right = '10px';
        btn.style.zIndex = '10000';
    } else {
        body.classList.remove('cockpit-mode');
        btn.innerHTML = '🚀 Cockpit';
        btn.style.position = 'static';
        if(isDataLoaded) renderList(); 
    }
    
    if (isCockpitMode && isDataLoaded) renderActionDiv(currentActiveIndex);
}

function formatTime(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return "--:--";
    const absSec = Math.abs(Math.round(totalSeconds));
    const m = Math.floor(absSec / 60).toString().padStart(2, '0');
    const s = (absSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function updateMainDelta(delta) {
    const el = document.getElementById('main-delta');
    if (delta === null) {
        el.textContent = "";
        el.className = "";
        return;
    }
    if (delta >= 0) {
        el.textContent = `-${formatTime(delta)}`;
        el.className = "ahead";
    } else {
        el.textContent = `+${formatTime(Math.abs(delta))}`;
        el.className = "behind";
    }
}

function resetRideProgress() {
    if(confirm("Are you sure you want to reset? All current ride progress will be lost.")) {
        hardResetState(true);
        renderList();
        if (isCockpitMode) renderActionDiv(currentActiveIndex);
    }
}

function hardResetState(fullReset) {
    clearInterval(timerInterval);
    timerInterval = null;
    startTime = null;
    currentActiveIndex = 0;
    
    actualCumSecData = new Array(activeSegments.length).fill(null);
    trendData = new Array(activeSegments.length).fill(null);
    currentSegTimeData = new Array(activeSegments.length).fill(null);
    currentSegWattsData = new Array(activeSegments.length).fill(null);
    
    document.getElementById('timer').innerText = "00:00";
    updateMainDelta(null);
    document.getElementById('startBtn').style.backgroundColor = 'var(--zwift-orange)';
    document.getElementById('startBtn').innerText = "START";
    document.getElementById('resetBtn').style.display = 'none';
    
    if (fullReset) {
        document.getElementById('targetTimeInput').disabled = false;
        document.getElementById('splitSlider').disabled = false;
        document.getElementById('climbSelect').disabled = false;
        document.getElementById('attemptSelect').disabled = false;
        document.getElementById('fetchBtn').disabled = false;
        document.getElementById('toggleSettingsBtn').style.display = 'block';
    }

    if(pacingTrendChart) { pacingTrendChart.data.datasets[0].data = trendData; pacingTrendChart.update(); }
    if(comparisonChart) { comparisonChart.data.datasets[2].data = currentSegWattsData; comparisonChart.data.datasets[5].data = currentSegTimeData; comparisonChart.update(); }
}

function startRide() {
    if (!isDataLoaded || timerInterval) return; 
    startTime = Date.now();
    document.getElementById('startBtn').style.backgroundColor = '#334155';
    document.getElementById('startBtn').innerText = "RIDING";
    document.getElementById('resetBtn').style.display = 'inline-block';
    
    document.getElementById('targetTimeInput').disabled = true;
    document.getElementById('splitSlider').disabled = true;
    document.getElementById('climbSelect').disabled = true;
    document.getElementById('attemptSelect').disabled = true;
    document.getElementById('fetchBtn').disabled = true;
    document.getElementById('data-settings-box').style.display = 'none';
    document.getElementById('toggleSettingsBtn').style.display = 'none';
    
    renderActionDiv(currentActiveIndex); 
    
    timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('timer').innerText = formatTime(elapsedSec);
    }, 1000);
}

function recordSplit(index) {
    if (!startTime || index !== currentActiveIndex) return; 

    const currentCumSec = Math.floor((Date.now() - startTime) / 1000);
    actualCumSecData[index] = currentCumSec;
    
    const prevCumSec = index > 0 ? actualCumSecData[index-1] : 0;
    currentSegTimeData[index] = currentCumSec - prevCumSec;
    
    const splitDelta = activeSegments[index].targetCumSec - currentCumSec;
    trendData[index] = splitDelta;
    
    updateMainDelta(splitDelta);
    currentActiveIndex = index + 1; 

    if (pacingTrendChart) pacingTrendChart.update();
    if (comparisonChart) comparisonChart.update();

    renderActionDiv(index);
    if (index > 0) renderActionDiv(index - 1); 
    if (index + 1 < activeSegments.length) renderActionDiv(index + 1); 
}

function undoSplit(index) {
    if (index !== currentActiveIndex - 1) return;

    actualCumSecData[index] = null;
    currentSegTimeData[index] = null;
    trendData[index] = null;
    currentSegWattsData[index] = null;

    if (index > 0) {
        const prevIndex = index - 1;
        const prevDelta = activeSegments[prevIndex].targetCumSec - actualCumSecData[prevIndex];
        updateMainDelta(prevDelta);
    } else {
        updateMainDelta(null);
    }

    currentActiveIndex = index; 

    if (pacingTrendChart) pacingTrendChart.update();
    if (comparisonChart) comparisonChart.update();

    renderActionDiv(index);
    if (index > 0) renderActionDiv(index - 1);
    if (index + 1 < activeSegments.length) renderActionDiv(index + 1);
}

function updateComparisonWatts(index, element) {
    const val = element.value;
    if (val === '') {
        currentSegWattsData[index] = null;
        element.style.border = '1px solid #1e293b';
        element.style.color = 'var(--cur-color)'; 
    } else {
        const watts = parseInt(val);
        if (!isNaN(watts)) {
            currentSegWattsData[index] = watts;
            applyPowerInputStyles(element, watts, activeSegments[index].targetPower);
        }
    }
    if (comparisonChart) comparisonChart.update('none'); 
}

function applyPowerInputStyles(inputEl, userPower, targetPower) {
    if (userPower >= targetPower) {
        inputEl.style.border = '1px solid var(--ahead-green)';
        inputEl.style.color = 'var(--ahead-green)';
    } else {
        inputEl.style.border = '1px solid var(--behind-red)';
        inputEl.style.color = 'var(--behind-red)';
    }
}

function buildActionHtml(i) {
    if (!isDataLoaded) return `<button class="split-btn" disabled>Split</button>`;

    if (actualCumSecData[i] !== null) {
        const currentCumSec = actualCumSecData[i];
        const prevCumSec = i > 0 ? actualCumSecData[i-1] : 0;
        const segDuration = currentCumSec - prevCumSec;
        const delta = activeSegments[i].targetCumSec - currentCumSec;
        let resTxt = delta >= 0 ? `-${formatTime(delta)} Ahead` : `+${formatTime(Math.abs(delta))} Behind`;
        let resCls = delta >= 0 ? 'ahead' : 'behind';
        const isLastCompleted = (i === currentActiveIndex - 1);
        const undoBtnHtml = isLastCompleted ? `<button class="undo-btn" onclick="undoSplit(${i})">↺ Undo</button>` : '';
        const existingPower = currentSegWattsData[i] !== null ? currentSegWattsData[i] : '';

        return `
            <div class="result-container" style="align-items: center;">
                <div class="time-row"><span class="cur-cum">${formatTime(currentCumSec)}</span> | <span class="cur-seg">Seg: ${formatTime(segDuration)}</span></div>
                <div class="time-row result ${resCls}">${resTxt}</div>
                <div class="power-input-container">
                    ${undoBtnHtml}
                    <span class="power-label">Avg W:</span>
                    <input type="number" inputmode="decimal" id="power-${i}" class="power-input" placeholder="--" value="${existingPower}" oninput="updateComparisonWatts(${i}, this)">
                </div>
            </div>
        `;
    } else if (i === currentActiveIndex) {
        const disabledState = !startTime ? 'disabled' : '';
        return `<button class="split-btn" ${disabledState} onclick="recordSplit(${i})" style="width: 100%; max-width: 300px;">Split: ${activeSegments[i].name}</button>`;
    } else {
        return `<button class="split-btn" disabled>Split: ${activeSegments[i].name}</button>`;
    }
}

function renderActionDiv(i) {
    const actionDiv = document.getElementById(`action-${i}`);
    if (actionDiv) {
        actionDiv.innerHTML = buildActionHtml(i);
        const existingPower = currentSegWattsData[i] !== null ? currentSegWattsData[i] : '';
        if (existingPower !== '') {
            applyPowerInputStyles(document.getElementById(`power-${i}`), parseInt(existingPower), activeSegments[i].targetPower);
        }
    }

    if (isCockpitMode && i === currentActiveIndex || (i === currentActiveIndex -1)) {
        const cockpitZone = document.getElementById('cockpit-active-segment');
        let html = "";
        
        if (currentActiveIndex > 0) {
            html += `<div style="margin-bottom: 15px; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px;">
                        <div style="font-size: 0.8em; color: #94a3b8; margin-bottom: 5px;">Last: ${activeSegments[currentActiveIndex-1].name}</div>
                        ${buildActionHtml(currentActiveIndex-1)}
                     </div>`;
        }
        if (currentActiveIndex < activeSegments.length) {
            html += `<div style="font-size: 1.2em; margin-bottom: 10px; color: var(--target-blue);">Next: ${activeSegments[currentActiveIndex].name}</div>`;
            html += buildActionHtml(currentActiveIndex);
        } else {
            html += `<div style="font-size: 1.5em; color: var(--ahead-green); font-weight: bold;">RIDE COMPLETE!</div>`;
        }

        cockpitZone.innerHTML = html;
        
        if (currentActiveIndex > 0) {
            const existingPowerCockpit = currentSegWattsData[currentActiveIndex-1] !== null ? currentSegWattsData[currentActiveIndex-1] : '';
            if (existingPowerCockpit !== '') {
                 const inputs = cockpitZone.getElementsByTagName('input');
                 if(inputs.length > 0) applyPowerInputStyles(inputs[0], parseInt(existingPowerCockpit), activeSegments[currentActiveIndex-1].targetPower);
            }
        }
    }
}

function renderList() {
    const list = document.getElementById('segmentList');
    list.innerHTML = '';
    let runningPrevCumSec = 0;

    activeSegments.forEach((seg, index) => {
        const prevTargetCumSec = index > 0 && activeSegments[index-1].targetCumSec !== null ? activeSegments[index-1].targetCumSec : 0;
        const targetSegSec = seg.targetCumSec !== null ? (seg.targetCumSec - prevTargetCumSec) : null;
        if (seg.prevSegSec !== null) runningPrevCumSec += seg.prevSegSec;

        const targetTimeStr = seg.targetCumSec !== null ? formatTime(seg.targetCumSec) : "--:--";
        const targetSegTimeStr = targetSegSec !== null ? formatTime(targetSegSec) : "--:--";
        const targetPowerStr = seg.targetPower !== null ? seg.targetPower + 'W' : '--W';
        
        const div = document.createElement('div');
        div.className = 'segment';
        div.innerHTML = `
            <div class="segment-info">
                <div class="segment-name">${seg.name}</div>
                <div class="segment-target" style="color: var(--target-blue); font-weight: bold;">Target: ${targetTimeStr} (${targetSegTimeStr}) @ ${targetPowerStr}</div>
                <div class="prev-data-row">Prev: ${formatTime(runningPrevCumSec)} (${formatTime(seg.prevSegSec)}) @ ${seg.prevWatts !== null ? seg.prevWatts+'W' : '--W'}</div>
            </div>
            <div class="segment-action" id="action-${index}"></div>
        `;
        list.appendChild(div);
        renderActionDiv(index); 
    });
    
    initCharts();
}

function initCharts() {
    Chart.defaults.color = '#64748b'; 
    Chart.defaults.borderColor = '#e2e8f0'; 
    Chart.defaults.font.size = 10;

    const chartLabels = activeSegments.map((seg, i) => {
        if (i === 0) return "Start";
        if (i === activeSegments.length - 1) return "Banner";
        let splitName = seg.name.split(" to ");
        return splitName.length > 1 ? "B" + splitName[1] : "S" + i;
    });

    const prevSegTimeData = activeSegments.map(s => s.prevSegSec);
    const prevSegWattsData = activeSegments.map(s => s.prevWatts);
    const targetWattsData = activeSegments.map(s => s.targetPower);
    const targetSegTimeData = activeSegments.map((s, i) => {
        if (s.targetCumSec === null) return null;
        return i === 0 ? s.targetCumSec : s.targetCumSec - activeSegments[i-1].targetCumSec;
    });

    if(pacingTrendChart) pacingTrendChart.destroy();
    const ctxTrend = document.getElementById('pacingTrendChart').getContext('2d');
    pacingTrendChart = new Chart(ctxTrend, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [{
                label: 'Time Ahead/Behind', data: trendData, borderColor: '#000000', borderWidth: 2, 
                pointBackgroundColor: '#fff', pointRadius: 3, tension: 0.1,
                fill: { target: 'origin', above: 'rgba(76, 175, 80, 0.4)', below: 'rgba(252, 103, 25, 0.4)' }
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: {
                y: { ticks: { stepSize: 30, callback: (v) => (v >= 0 ? '+' : '-') + formatTime(v) } },
                x: { ticks: { maxRotation: 45, minRotation: 45 } }
            }
        }
    });

    if(comparisonChart) comparisonChart.destroy();
    const ctxComp = document.getElementById('comparisonChart').getContext('2d');
    comparisonChart = new Chart(ctxComp, {
        data: {
            labels: chartLabels,
            datasets: [
                { type: 'line', label: 'Prev W', data: prevSegWattsData, borderColor: '#888', borderDash: [1, 2], borderWidth: 1.5, fill: false, pointRadius: 0, yAxisID: 'y1' },
                { type: 'line', label: 'Target W', data: targetWattsData, borderColor: '#3daee9', borderDash: [6, 4], borderWidth: 2, fill: false, pointRadius: 0, yAxisID: 'y1' },
                { type: 'line', label: 'Cur W', data: currentSegWattsData, borderColor: '#4caf50', borderDash: [], borderWidth: 3, fill: false, pointRadius: 2, yAxisID: 'y1' },
                { type: 'bar', label: 'Prev Time', data: prevSegTimeData, backgroundColor: 'rgba(136, 136, 136, 0.4)', barPercentage: 0.9, categoryPercentage: 0.8, yAxisID: 'y' },
                { type: 'bar', label: 'Target Time', data: targetSegTimeData, backgroundColor: 'rgba(61, 174, 233, 0.4)', barPercentage: 0.9, categoryPercentage: 0.8, yAxisID: 'y' },
                { type: 'bar', label: 'Cur Time', data: currentSegTimeData, backgroundColor: 'rgba(76, 175, 80, 0.7)', barPercentage: 0.9, categoryPercentage: 0.8, yAxisID: 'y' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 9 }, padding: 5 } } },
            scales: {
                y: { type: 'linear', position: 'left', min: 0, ticks: { callback: v => formatTime(v) } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, min: 150, suggestedMax: 350, ticks: { callback: v => v + 'W' } },
                x: { ticks: { maxRotation: 45, minRotation: 45 }, stacked: false }
            }
        }
    });
}

// Kick off the application
initAuth();
loadSegmentsConfig();
