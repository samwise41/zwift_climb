// ==========================================
// js/engine.js - APIs, GPX Parsing & Math
// ==========================================

function processDataRequest() {
    if (currentClimb.id === "custom") {
        parseGPXFile();
    } else {
        fetchUserData();
    }
}

async function fetchUserData() {
    if (!stravaAccessToken || !currentClimb) return;

    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `⏳ Searching Strava...`;
    statusEl.style.display = 'inline-block';
    statusEl.classList.remove("ahead", "behind"); 

    if (DEV_MODE) {
        setTimeout(() => {
            let dummySegments = [];
            let defaultTotalSecs = parseTimeToSeconds(currentClimb.defaultTime);
            let avgSecsPerSegment = Math.round(defaultTotalSecs / currentClimb.subSegments.length);

            for (let i = 0; i < currentClimb.subSegments.length; i++) {
                let mockSegSec = avgSecsPerSegment + (Math.floor(Math.random() * 30) - 15);
                let mockWatts = 210 + Math.floor(Math.random() * 60); 
                dummySegments.push({ name: currentClimb.subSegments[i], prevSegSec: mockSegSec, prevWatts: mockWatts, targetCumSec: null, targetPower: null });
            }
            saveAndLoadData(dummySegments, "DEV MODE Data Loaded");
        }, 600); 
        return;
    }

    const attemptType = document.getElementById('attemptSelect').value;
    // Always fetch 50 so we can accurately sort for either "best" or "most recent"
    const fetchLimit = 50; 

    try {
        const effortsRes = await fetch(`https://www.strava.com/api/v3/segment_efforts?segment_id=${currentClimb.id}&per_page=${fetchLimit}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        if (effortsRes.status === 429) {
            statusEl.innerHTML = `⚠️ Strava Limit Reached. Use Custom Route (GPX) mode. <a href="https://www.strava.com/athlete/training" target="_blank" style="color:white; text-decoration:underline;">Export GPX here</a>`;
            statusEl.classList.add("behind");
            return;
        }
        
        let effortsData = await effortsRes.json();

        if (effortsData.message === "Authorization Error" || effortsRes.status === 401) {
            safeStorage.remove('strava_token'); 
            statusEl.innerText = `❌ Session expired.`;
            statusEl.classList.add("behind");
            document.getElementById('strava-btn').style.display = 'inline-block';
            return;
        }

        if (!effortsData || effortsData.length === 0 || effortsData.errors) {
            statusEl.innerText = `❌ No efforts found.`;
            statusEl.classList.add("behind");
            return;
        }

        // --- SORTING LOGIC FIX ---
        if (attemptType === 'best') {
            // Sort by fastest elapsed time
            effortsData.sort((a, b) => a.elapsed_time - b.elapsed_time);
        } else {
            // Sort by most recent date (newest first)
            effortsData.sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime());
        }

        const targetEffort = effortsData[0];
        statusEl.innerText = `⏳ Loading full activity...`;

        const activityRes = await fetch(`https://www.strava.com/api/v3/activities/${targetEffort.activity.id}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        
        if (activityRes.status === 429) {
            statusEl.innerHTML = `⚠️ Strava Limit Reached. Use GPX Fallback.`;
            statusEl.classList.add("behind");
            return;
        }

        const activityData = await activityRes.json();
        let personalizedSegments = [];
        let missingSegments = [];

        for (let targetName of currentClimb.subSegments) {
            const regex = new RegExp("\\b" + targetName + "(?:\\b|\\s|$)", "i");
            const match = activityData.segment_efforts.find(seg => regex.test(seg.name));
            if (match) {
                personalizedSegments.push({ name: targetName, prevSegSec: match.elapsed_time, prevWatts: Math.round(match.average_watts || 0), targetCumSec: null, targetPower: null });
            } else {
                missingSegments.push(targetName);
            }
        }

        if (missingSegments.length === 0) {
            const successMsg = attemptType === 'best' ? "PR Loaded! Ready to pace." : "Recent Effort Loaded!";
            saveAndLoadData(personalizedSegments, successMsg);
        } else {
            console.warn("Missing:", missingSegments);
            statusEl.innerText = `⚠️ Missing ${missingSegments.length} hairpins.`;
            statusEl.classList.add("behind");
        }
    } catch (error) {
        console.error(error);
        statusEl.innerText = "❌ Connection Error";
        statusEl.classList.add("behind");
    }
}

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2-lat1) * (Math.PI/180);
    const dLon = (lon2-lon1) * (Math.PI/180); 
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c; 
}

function parseGPXFile() {
    const fileInput = document.getElementById('gpxInput');
    const intervalKm = parseFloat(document.getElementById('splitIntervalKm').value) || 1.0;
    const statusEl = document.getElementById('strava-status');
    
    if (!fileInput.files || fileInput.files.length === 0) {
        statusEl.innerText = "⚠️ Please select a GPX file first.";
        statusEl.style.display = 'inline-block';
        statusEl.className = "status-text behind";
        return;
    }

    statusEl.innerText = "⏳ Parsing GPX...";
    statusEl.style.display = 'inline-block';
    statusEl.className = "status-text";

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(e.target.result, "text/xml");
            const trkpts = xmlDoc.getElementsByTagName("trkpt");
            
            if (trkpts.length === 0) throw new Error("No trackpoints found in GPX.");

            let generatedSegments = [];
            let currentSegmentStartIdx = 0;
            let currentSegmentWattsSum = 0;
            let currentSegmentWattsCount = 0;
            
            let cumulativeKm = 0;
            let targetNextSplitKm = intervalKm;
            
            let startPointTime = new Date(trkpts[0].getElementsByTagName("time")[0].textContent).getTime();

            for (let i = 1; i < trkpts.length; i++) {
                let lat1 = parseFloat(trkpts[i-1].getAttribute("lat"));
                let lon1 = parseFloat(trkpts[i-1].getAttribute("lon"));
                let lat2 = parseFloat(trkpts[i].getAttribute("lat"));
                let lon2 = parseFloat(trkpts[i].getAttribute("lon"));
                
                cumulativeKm += getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2);
                
                let ext = trkpts[i].getElementsByTagName("extensions")[0];
                if (ext) {
                    let pwrNode = ext.getElementsByTagName("power")[0];
                    if (pwrNode) {
                        currentSegmentWattsSum += parseInt(pwrNode.textContent);
                        currentSegmentWattsCount++;
                    }
                }

                if (cumulativeKm >= targetNextSplitKm || i === trkpts.length - 1) {
                    let endPointTime = new Date(trkpts[i].getElementsByTagName("time")[0].textContent).getTime();
                    let segSecs = Math.round((endPointTime - startPointTime) / 1000);
                    let avgWatts = currentSegmentWattsCount > 0 ? Math.round(currentSegmentWattsSum / currentSegmentWattsCount) : 0;
                    
                    let segName = i === trkpts.length - 1 ? "Finish" : `Km ${targetNextSplitKm.toFixed(1)}`;

                    generatedSegments.push({
                        name: segName,
                        prevSegSec: segSecs,
                        prevWatts: avgWatts,
                        targetCumSec: null, targetPower: null
                    });

                    startPointTime = endPointTime;
                    currentSegmentWattsSum = 0;
                    currentSegmentWattsCount = 0;
                    targetNextSplitKm += intervalKm;
                }
            }

            saveAndLoadData(generatedSegments, "GPX Parsed Successfully!");

        } catch (err) {
            console.error(err);
            statusEl.innerText = "❌ Error reading GPX format.";
            statusEl.className = "status-text behind";
        }
    };
    reader.readAsText(fileInput.files[0]);
}

function saveAndLoadData(segmentDataArray, successMsg) {
    baseSegments = segmentDataArray; 
    isDataLoaded = true; 
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('data-settings-box').style.display = 'none'; 
    document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';
    
    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `✓ ${successMsg}`;
    statusEl.className = "status-text ahead";

    applyNewTarget(); 

    const cacheObject = {
        climbName: currentClimb.name,
        targetTimeStr: document.getElementById('targetTimeInput').value,
        baseSegments: baseSegments
    };
    safeStorage.set('pacer_cache_data', JSON.stringify(cacheObject));
}

function parseTimeToSeconds(timeStr) {
    if(!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 2) {
        return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
    }
    return (parseInt(parts[0]) || 0) * 60;
}

function applyNewTarget() {
    if (!isDataLoaded) {
        renderList(); 
        return;
    }

    const targetSeconds = parseTimeToSeconds(document.getElementById('targetTimeInput').value);
    if (targetSeconds <= 0) return; 

    const sliderVal = parseInt(document.getElementById('splitSlider').value) / 100;
    const historicalTotal = baseSegments.reduce((sum, s) => sum + s.prevSegSec, 0);
    const baseRatio = targetSeconds / historicalTotal;

    let tempSegments = baseSegments.map((seg, i) => {
        const position = (i / (baseSegments.length - 1)) * 2 - 1;
        const splitMultiplier = 1 + (position * sliderVal);
        return { ...seg, rawScaledSec: seg.prevSegSec * baseRatio * splitMultiplier };
    });

    const rawTotalTime = tempSegments.reduce((sum, s) => sum + s.rawScaledSec, 0);
    const correctionFactor = targetSeconds / rawTotalTime;

    let cumulativeSec = 0;
    activeSegments = tempSegments.map(seg => {
        const finalSegSec = Math.round(seg.rawScaledSec * correctionFactor);
        cumulativeSec += finalSegSec;
        
        const timeRatio = finalSegSec / seg.prevSegSec;
        const newPower = Math.round(seg.prevWatts * (1 / timeRatio));

        return { ...seg, targetCumSec: cumulativeSec, targetPower: newPower };
    });

    document.getElementById('title-text').innerText = `${currentClimb.name} (${formatTime(targetSeconds)})`;
    hardResetState(false); 
    renderList();
    
    if (isDataLoaded) {
        const cacheStr = safeStorage.get('pacer_cache_data');
        if (cacheStr) {
            let cacheObj = JSON.parse(cacheStr);
            cacheObj.targetTimeStr = document.getElementById('targetTimeInput').value;
            cacheObj.baseSegments = activeSegments; 
            safeStorage.set('pacer_cache_data', JSON.stringify(cacheObj));
        }
    }
}
