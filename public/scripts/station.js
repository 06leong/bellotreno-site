
// BelloTreno © 2026


function getItalianTimeString() {
    const now = new Date();

    const italianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));

    const offsetParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Rome', timeZoneName: 'shortOffset'
    }).formatToParts(now);
    const tzPart = offsetParts.find(p => p.type === 'timeZoneName');
    let timezone = 'GMT+0100';
    if (tzPart) {
        const m = tzPart.value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
        if (m) {
            const sign = m[1];
            const hrs = m[2].padStart(2, '0');
            const mins = m[3] || '00';
            timezone = `GMT${sign}${hrs}${mins}`;
        }
    }

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const weekday = weekdays[italianTime.getDay()];
    const monthName = months[italianTime.getMonth()];
    const day = String(italianTime.getDate()).padStart(2, '0');
    const yearStr = italianTime.getFullYear();
    const hour = String(italianTime.getHours()).padStart(2, '0');
    const minute = String(italianTime.getMinutes()).padStart(2, '0');
    const second = String(italianTime.getSeconds()).padStart(2, '0');

    return `${weekday} ${monthName} ${day} ${yearStr} ${hour}:${minute}:${second} ${timezone}`;
}


function goToStationBoard(stationId, stationName) {
    
    const params = new URLSearchParams({
        id: stationId,
        name: stationName,
        type: 'partenze' 
    });
    window.location.href = `/station?${params.toString()}`;
}


async function fetchStationBoard(stationId, type = 'partenze') {
    const timeString = getItalianTimeString();
    const encodedTime = encodeURIComponent(timeString);
    
    const apiBase = window.API_BASE;
    const url = `${apiBase}/${type}/${stationId}/${encodedTime}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Failed to fetch station board:', error);
        throw error;
    }
}

const OPERATOR_MAP = window.CLIENT_MAP || {};


function formatTrainNumber(trainNumberStr) {
    if (!trainNumberStr) return '';

    
    trainNumberStr = trainNumberStr.trim();

    
    
    const match = trainNumberStr.match(/^([A-Z\s]+?)\s*(\d+)$/);
    if (match) {
        let catCode = match[1].trim();
        const num = match[2];

        
        if (catCode.toUpperCase().includes("EC FR")) {
            catCode = "FR";
        }

        
        if (catCode.toUpperCase().includes("TS")) {
            catCode = "TS";
        }

        
        let badgeClass = '';
        if (['REG', 'RE', 'RV', 'MET'].includes(catCode)) {
            badgeClass = 'badge-regional';
        } else if (['FR', 'FB', 'FA'].includes(catCode)) {
            badgeClass = 'badge-arrow';
        } else if (['IC', 'ICN'].includes(catCode)) {
            badgeClass = 'badge-intercity';
        } else if (['EC', 'EN'].includes(catCode)) {
            badgeClass = 'badge-international';
        } else if (catCode === 'TS') {
            badgeClass = 'badge-storico';
        } else if (catCode === 'EXP') {
            badgeClass = 'badge-espresso';
        }

        if (badgeClass) {
            
            return `<span class="train-badge ${badgeClass}">${catCode}<br>${num}</span>`;
        }
        return `${catCode}<br>${num}`;
    }

    
    return trainNumberStr;
}


const STATION_TRANSLATIONS = {
    zh: { cancelled: '已取消', not_departed: '未出发', delayed: '晚点', early: '提前', on_time: '准点', minutes: '分钟' },
    en: { cancelled: 'CANCELLED', not_departed: 'Not Departed', delayed: 'Delayed', early: 'Early', on_time: 'On Time', minutes: 'min' },
    it: { cancelled: 'CANCELLATO', not_departed: 'Non partito', delayed: 'Ritardo', early: 'In anticipo', on_time: 'In orario', minutes: 'min' }
};

function formatDepartureData(train, currentLang = 'zh', currentStation = '') {
    const t = STATION_TRANSLATIONS[currentLang] || STATION_TRANSLATIONS.zh;

    
    const scheduledTime = train.compOrarioPartenza || '--:--';

    
    const trainNumber = formatTrainNumber(train.compNumeroTreno || '');

    
    const destination = (train.destinazioneEstera &&
        train.destinazioneEstera !== train.origine &&
        train.destinazioneEstera.toUpperCase() !== currentStation.toUpperCase())
        ? train.destinazioneEstera : (train.destinazione || '');

    
    let status = '';
    let statusColor = 'green';

    if (train.provvedimento == 1) {
        status = t.cancelled;
        statusColor = 'red';
    } else if (train.nonPartito === true) {
        status = t.not_departed;
        statusColor = 'grey';
    } else if (train.ritardo > 0) {
        status = `${t.delayed} ${train.ritardo} ${t.minutes}`;
        statusColor = 'red';
    } else {
        status = t.on_time;
        statusColor = 'green';
    }

    
    const actualPlatform = train.binarioEffettivoPartenzaDescrizione || '';
    const scheduledPlatform = train.binarioProgrammatoPartenzaDescrizione || '';
    const inStazione = train.inStazione === true;
    let platformHtml = '';

    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span style="color:red; font-weight:bold;"${pulseClass}>${actualPlatform}</span> <del style="color:grey;">${scheduledPlatform}</del>`;
    } else if (actualPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${actualPlatform}</span>`;
    } else if (scheduledPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${scheduledPlatform}</span>`;
    } else {
        platformHtml = '--';
    }

    return {
        scheduledTime,
        trainNumber,
        destination,
        status,
        statusColor,
        platformHtml,
        inStazione,
        rawData: train
    };
}


function formatArrivalData(train, currentLang = 'zh', currentStation = '') {
    const t = STATION_TRANSLATIONS[currentLang] || STATION_TRANSLATIONS.zh;

    
    const scheduledTime = train.compOrarioArrivo || '--:--';

    
    const origin = (train.origineEstera &&
        train.origineEstera !== train.destinazione &&
        train.origineEstera.toUpperCase() !== currentStation.toUpperCase())
        ? train.origineEstera : (train.origine || '');

    
    const trainNumber = formatTrainNumber(train.compNumeroTreno || '');

    
    let actualTime = scheduledTime;
    if (train.compOrarioEffettivoArrivo) {
        
        const match = train.compOrarioEffettivoArrivo.match(/(\d{2}:\d{2})$/);
        if (match) {
            actualTime = match[1];
        }
    }

    
    let status = '';
    let statusColor = 'green';

    if (train.provvedimento == 1) {
        status = t.cancelled;
        statusColor = 'red';
    } else if (train.ritardo > 0) {
        status = `${t.delayed} ${train.ritardo} ${t.minutes}`;
        statusColor = 'red';
    } else if (train.ritardo < 0) {
        status = `${t.early} ${Math.abs(train.ritardo)} ${t.minutes}`;
        statusColor = 'green';
    } else {
        status = t.on_time;
        statusColor = 'green';
    }

    
    const actualPlatform = train.binarioEffettivoArrivoDescrizione || '';
    const scheduledPlatform = train.binarioProgrammatoArrivoDescrizione || '';
    const inStazione = train.inStazione === true;
    let platformHtml = '';

    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span style="color:red; font-weight:bold;"${pulseClass}>${actualPlatform}</span> <del style="color:grey;">${scheduledPlatform}</del>`;
    } else if (actualPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${actualPlatform}</span>`;
    } else if (scheduledPlatform) {
        const pulseClass = inStazione ? ' class="platform-pulse"' : '';
        platformHtml = `<span${pulseClass}>${scheduledPlatform}</span>`;
    } else {
        platformHtml = '--';
    }

    return {
        scheduledTime,
        origin,
        trainNumber,
        actualTime,
        status,
        statusColor,
        platformHtml,
        inStazione,
        rawData: train
    };
}


if (typeof module !== 'undefined' && module.exports) {
    
    module.exports = {
        getItalianTimeString,
        goToStationBoard,
        fetchStationBoard,
        formatDepartureData,
        formatArrivalData
    };
} else {
    
    window.getItalianTimeString = getItalianTimeString;
    window.goToStationBoard = goToStationBoard;
    window.fetchStationBoard = fetchStationBoard;
    window.formatDepartureData = formatDepartureData;
    window.formatArrivalData = formatArrivalData;
}
