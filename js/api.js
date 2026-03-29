// --- Strava API Fetcher ---
async function fetchUserData() {
    if (!stravaAccessToken || !currentClimb) return;

    const statusEl = document.getElementById('strava-status');
    statusEl.innerText = `⏳ Searching...`;
    statusEl.style.display = 'inline-block';
    statusEl.classList.remove("ahead", "behind"); 

    // DEV MODE FAKE DATA GENERATOR
    if (DEV_MODE) {
        setTimeout(() => {
            let dummySegments = [];
            let defaultTotalSecs = parseTimeToSeconds(currentClimb.defaultTime);
            let avgSecsPerSegment = Math.round(defaultTotalSecs / currentClimb.subSegments.length);

            for (let i = 0; i < currentClimb.subSegments.length; i++) {
                // Add +/- 15 seconds of randomness to make it look real
                let mockSegSec = avgSecsPerSegment + (Math.floor(Math.random() * 30) - 15);
                // Random watts between 210 and 270
                let mockWatts = 210 + Math.floor(Math.random() * 60); 
                
                dummySegments.push({
                    name: currentClimb.subSegments[i],
                    prevSegSec: mockSegSec,
                    prevWatts: mockWatts,
                    targetCumSec: null, targetPower: null
                });
            }

            baseSegments = dummySegments; 
            isDataLoaded = true; 
            document.getElementById('startBtn').disabled = false;
            document.getElementById('data-settings-box').style.display = 'none'; 
            document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';
            applyNewTarget(); 
            
            statusEl.innerText = `✓ DEV MODE Data Loaded!`;
            statusEl.classList.add("ahead");
        }, 600); 
        return;
    }

    // NORMAL STRAVA API FETCH
    const attemptType = document.getElementById('attemptSelect').value;
    const fetchLimit = attemptType === 'best' ? 50 : 1;

    try {
        const effortsRes = await fetch(`https://www.strava.com/api/v3/segment_efforts?segment_id=${currentClimb.id}&per_page=${fetchLimit}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        let effortsData = await effortsRes.json();

        if (effortsData.message === "Authorization Error" || effortsRes.status === 401) {
            safeStorage.remove('strava_token'); 
            safeStorage.remove('strava_expiry');
            statusEl.innerText = `❌ Session expired.`;
            statusEl.classList.add("behind");
            document.getElementById('strava-btn').style.display = 'inline-block';
            document.getElementById('settings-container').style.display = 'none';
            return;
        }

        if (!effortsData || effortsData.length === 0 || effortsData.errors) {
            statusEl.innerText = `❌ No efforts found for ${currentClimb.name}.`;
            statusEl.classList.add("behind");
            return;
        }

        if (attemptType === 'best') {
            effortsData.sort((a, b) => a.elapsed_time - b.elapsed_time);
        }

        const targetEffort = effortsData[0];
        const activityId = targetEffort.activity.id;

        statusEl.innerText = `⏳ Loading activity...`;

        const activityRes = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
            headers: { 'Authorization': `Bearer ${stravaAccessToken}` }
        });
        const activityData = await activityRes.json();
        const segmentEfforts = activityData.segment_efforts;

        let personalizedSegments = [];
        let missingSegments = [];

        for (let targetName of currentClimb.subSegments) {
            const regex = new RegExp("\\b" + targetName + "(?:\\b|\\s|$)", "i");
            const match = segmentEfforts.find(seg => regex.test(seg.name));
            
            if (match) {
                personalizedSegments.push({
                    name: targetName,
                    prevSegSec: match.elapsed_time,
                    prevWatts: Math.round(match.average_watts || 0),
                    targetCumSec: null, targetPower: null
                });
            } else {
                missingSegments.push(targetName);
            }
        }

        if (missingSegments.length === 0) {
            baseSegments = personalizedSegments; 
            isDataLoaded = true; 
            
            document.getElementById('startBtn').disabled = false;
            document.getElementById('data-settings-box').style.display = 'none'; 
            document.getElementById('toggleSettingsBtn').innerHTML = '▶ Show Settings';

            applyNewTarget(); 
            
            statusEl.innerText = `✓ PR Loaded! Ready to pace.`;
            statusEl.classList.add("ahead");
        } else {
            console.warn("⚠️ Missing Sub-Segments:", missingSegments);
            statusEl.innerText = `⚠️ Missing ${missingSegments.length} hairpins.`;
            statusEl.classList.add("behind");
        }
    } catch (error) {
        console.error(error);
        statusEl.innerText = "❌ Connection Error";
        statusEl.classList.add("behind");
    }
}

// --- App Initialization ---
initAuth();
loadSegmentsConfig();
