// 车站看板功能 - Station Board Integration
// BelloTreno © 2026

// 获取意大利当前时间字符串（考虑夏令时）
function getItalianTimeString() {
    const now = new Date();
    
    // 获取意大利时区的时间
    const italianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    
    // 判断是否为夏令时 (CEST: 3月最后一个周日 至 10月最后一个周日)
    const year = italianTime.getFullYear();
    const month = italianTime.getMonth(); // 0-11
    
    // 简化判断：3月-10月可能是夏令时
    let isDST = false;
    if (month > 2 && month < 9) {
        isDST = true; // 4月到9月肯定是夏令时
    } else if (month === 2) {
        // 3月：需要判断是否过了最后一个周日
        const lastSunday = new Date(year, 2, 31);
        lastSunday.setDate(31 - lastSunday.getDay());
        isDST = italianTime.getDate() >= lastSunday.getDate();
    } else if (month === 9) {
        // 10月：需要判断是否过了最后一个周日
        const lastSunday = new Date(year, 9, 31);
        lastSunday.setDate(31 - lastSunday.getDay());
        isDST = italianTime.getDate() < lastSunday.getDate();
    }
    
    const timezone = isDST ? 'GMT+0200' : 'GMT+0100';
    
    // 格式化时间字符串
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const weekday = weekdays[italianTime.getDay()];
    const monthName = months[italianTime.getMonth()];
    const day = String(italianTime.getDate()).padStart(2, '0');
    const yearStr = italianTime.getFullYear();
    const hour = String(italianTime.getHours()).padStart(2, '0');
    const minute = String(italianTime.getMinutes()).padStart(2, '0');
    const second = String(italianTime.getSeconds()).padStart(2, '0');
    
    // 格式: Sun Jan 18 2026 08:52:00 GMT+0100
    return `${weekday} ${monthName} ${day} ${yearStr} ${hour}:${minute}:${second} ${timezone}`;
}

// 跳转到车站看板页面
function goToStationBoard(stationId, stationName) {
    // 使用 URL 参数传递车站信息
    const params = new URLSearchParams({
        id: stationId,
        name: encodeURIComponent(stationName),
        type: 'partenze' // 默认显示离站
    });
    window.location.href = `real_station.html?${params.toString()}`;
}

// 获取车站看板数据
async function fetchStationBoard(stationId, type = 'partenze') {
    const timeString = getItalianTimeString();
    const encodedTime = encodeURIComponent(timeString);
    // 使用 window.API_BASE 或者直接使用完整 URL
    const apiBase = window.API_BASE || "https://api.bellotreno.org/?url=https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";
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

// 运营商代码映射
const OPERATOR_MAP = {
    1: "Trenitalia",
    2: "Trenitalia",
    4: "Trenitalia",
    18: "Trenitalia TPER",
    30: "Ferrovie del Sud Est",
    63: "Trenord",
    64: "ÖBB"
};

// 格式化离站看板数据
function formatDepartureData(train, currentLang = 'zh') {
    const translations = {
        zh: {
            cancelled: '已取消',
            not_departed: '未出发',
            delayed: '晚点',
            on_time: '准点',
            minutes: '分钟'
        },
        en: {
            cancelled: 'CANCELLED',
            not_departed: 'Not Departed',
            delayed: 'Delayed',
            on_time: 'On Time',
            minutes: 'min'
        },
        it: {
            cancelled: 'CANCELLATO',
            not_departed: 'Non partito',
            delayed: 'Ritardo',
            on_time: 'In orario',
            minutes: 'min'
        }
    };
    
    const t = translations[currentLang];
    
    // 时间
    const scheduledTime = train.compOrarioPartenza || '--:--';
    
    // 车次号
    const trainNumber = train.compNumeroTreno || '';
    
    // 目的地
    const destination = train.destinazioneEstera || train.destinazione || '';
    
    // 状态
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
    
    // 站台
    const actualPlatform = train.binarioEffettivoPartenzaDescrizione || '';
    const scheduledPlatform = train.binarioProgrammatoPartenzaDescrizione || '';
    let platformHtml = '';
    
    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        // 站台变更
        platformHtml = `<span style="color:red; font-weight:bold;">${actualPlatform}</span> <del>${scheduledPlatform}</del>`;
    } else if (actualPlatform) {
        platformHtml = actualPlatform;
    } else if (scheduledPlatform) {
        platformHtml = scheduledPlatform;
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
        rawData: train
    };
}

// 格式化到站看板数据
function formatArrivalData(train, currentLang = 'zh') {
    const translations = {
        zh: {
            cancelled: '已取消',
            delayed: '晚点',
            early: '提前',
            on_time: '准点',
            minutes: '分钟'
        },
        en: {
            cancelled: 'CANCELLED',
            delayed: 'Delayed',
            early: 'Early',
            on_time: 'On Time',
            minutes: 'min'
        },
        it: {
            cancelled: 'CANCELLATO',
            delayed: 'Ritardo',
            early: 'In anticipo',
            on_time: 'In orario',
            minutes: 'min'
        }
    };
    
    const t = translations[currentLang];
    
    // 计划到达时间
    const scheduledTime = train.compOrarioArrivo || '--:--';
    
    // 始发站
    const origin = train.origine || '';
    
    // 车次号
    const trainNumber = train.compNumeroTreno || '';
    
    // 实际/预计到达时间（从 compOrarioEffettivoArrivo 中提取）
    let actualTime = scheduledTime;
    if (train.compOrarioEffettivoArrivo) {
        // 提取最后5位时间，例如 "/.../regolare.png10:44" -> "10:44"
        const match = train.compOrarioEffettivoArrivo.match(/(\d{2}:\d{2})$/);
        if (match) {
            actualTime = match[1];
        }
    }
    
    // 状态
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
    
    // 到达站台
    const actualPlatform = train.binarioEffettivoArrivoDescrizione || '';
    const scheduledPlatform = train.binarioProgrammatoArrivoDescrizione || '';
    let platformHtml = '';
    
    if (actualPlatform && scheduledPlatform && actualPlatform !== scheduledPlatform) {
        // 站台变更 - 需要红色高亮或闪烁
        platformHtml = `<span style="color:red; font-weight:bold;">${actualPlatform}</span> <del>${scheduledPlatform}</del>`;
    } else if (actualPlatform) {
        platformHtml = actualPlatform;
    } else if (scheduledPlatform) {
        platformHtml = scheduledPlatform;
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
        rawData: train
    };
}

// 导出函数供其他模块使用
if (typeof module !== 'undefined' && module.exports) {
    // Node.js 环境
    module.exports = {
        getItalianTimeString,
        goToStationBoard,
        fetchStationBoard,
        formatDepartureData,
        formatArrivalData
    };
} else {
    // 浏览器环境 - 导出到全局 window 对象
    window.getItalianTimeString = getItalianTimeString;
    window.goToStationBoard = goToStationBoard;
    window.fetchStationBoard = fetchStationBoard;
    window.formatDepartureData = formatDepartureData;
    window.formatArrivalData = formatArrivalData;
}

// 调试信息
console.log('Station.js loaded successfully. Functions available:', {
    getItalianTimeString: typeof window.getItalianTimeString !== 'undefined',
    goToStationBoard: typeof window.goToStationBoard !== 'undefined',
    fetchStationBoard: typeof window.fetchStationBoard !== 'undefined'
});
