function generateNewPace(historicalSegments, newTargetSeconds) {
    // 1. Calculate total time of the historical effort
    const historicalTotal = historicalSegments.reduce((sum, s) => sum + s.seconds, 0);
    
    // 2. Find the scaling ratio (e.g., 0.8 if aiming for 20% faster)
    const ratio = newTargetSeconds / historicalTotal;

    // 3. Apply ratio to every segment
    return historicalSegments.map(seg => ({
        name: seg.name,
        targetSegSec: Math.round(seg.seconds * ratio),
        // Power required is roughly inverse to the time change
        targetPower: Math.round(seg.watts * (1 / ratio)) 
    }));
}
