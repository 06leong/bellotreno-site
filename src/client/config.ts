export {};

/**
 * BelloTreno Configuration
 */

window.PROXY_BASE = "https://ah.bellotreno.workers.dev";
window.API_BASE = window.PROXY_BASE + "/?url=https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";
window.NOTIFY_BASE = "https://notify.bellotreno.workers.dev";
window.TRENORD_TRAFFIC_BASE = "/api/trenord/traffic";
window.ITALO_TRAIN_BASE = "/api/italo/train";
window.ITALO_STATION_BASE = "/api/italo/station";
window.ITALO_STATIONS_BASE = "/api/italo/stations";
window.COUNTER_URL = "https://site-counter.bellotreno.workers.dev/";

const CLIENT_MAP = {
    1: "Trenitalia",
    2: "Trenitalia",
    4: "Trenitalia",
    18: "Trenitalia TPER",
    77: "FS Treni Turistici Italiani",
    910: "Ferrovie del Sud Est",
    63: "Trenord",
    64: "ÖBB",
    "ITALO": "Italo"
};
window.CLIENT_MAP = CLIENT_MAP;

const CLIENT_LINK_MAP = {
    "Trenitalia": "https://www.trenitalia.com",
    "Trenitalia TPER": "https://www.trenitalia.com",
    "Ferrovie del Sud Est": "https://www.trenitalia.com",
    "Trenord": "https://www.trenord.it",
    "ÖBB": "https://www.oebb.at",
    "FS Treni Turistici Italiani": "https://www.fstrenituristici.it",
    "Italo": "https://www.italotreno.com"
};

const CAT_MAP = {
    "AV": "Alta Velocità",
    "REG": "Regionale",
    "RV": "Regionale Veloce",
    "MET": "Metropolitan",
    "FR": "Frecciarossa",
    "IC": "Intercity",
    "ICN": "Intercity Notte",
    "EC": "Eurocity",
    "FB": "Frecciabianca",
    "FA": "Frecciargento",
    "EN": "EuroNight",
    "RE": "Regionale",
    "NCL": "NCL",
    "TS": "Treno Storico",
    "EXP": "Espresso"
};

const CAT_IMAGE_MAP = {
    "1-IC": "pic/IC.svg",
    "2-IC": "pic/IC.svg",
    "4-IC": "pic/IC.svg",
    "1-ICN": "pic/ICN.svg",
    "2-ICN": "pic/ICN.svg",
    "4-ICN": "pic/ICN.svg",
    "1-REG": "pic/RV.svg",
    "2-REG": "pic/RV.svg",
    "4-REG": "pic/RV.svg",
    "1-RV": "pic/RV.svg",
    "2-RV": "pic/RV.svg",
    "4-RV": "pic/RV.svg",
    "1-MET": "pic/RV.svg",
    "2-MET": "pic/RV.svg",
    "4-MET": "pic/RV.svg",
    "1-RE": "pic/RV.svg",
    "2-RE": "pic/RV.svg",
    "4-RE": "pic/RV.svg",
    "1-FR": "pic/FR.svg",
    "2-FR": "pic/FR.svg",
    "4-FR": "pic/FR.svg",
    "1-FA": "pic/FA.svg",
    "2-FA": "pic/FA.svg",
    "4-FA": "pic/FA.svg",
    "1-FB": "pic/FB.svg",
    "2-FB": "pic/FB.svg",
    "4-FB": "pic/FB.svg",
    "1-EC": "pic/EC.png",
    "2-EC": "pic/EC.png",
    "4-EC": "pic/EC.png",
    "1-EN": "pic/EN.png",
    "2-EN": "pic/EN.png",
    "4-EN": "pic/EN.png",
    "1-TS": "pic/FS.png",
    "2-TS": "pic/FS.png",
    "4-TS": "pic/FS.png",
    "1-EXP": "pic/Espresso.png",
    "2-EXP": "pic/Espresso.png",
    "4-EXP": "pic/Espresso.png",
    "18-REG": "pic/regn.png",
    "18-RV": "pic/RV.svg",
    "18-RE": "pic/RV.svg",
    "910-REG": "pic/regn.png",
    "910-RV": "pic/regn.png",
    "910-RE": "pic/regn.png",
    "63-REG": "pic/regn.png",
    "63-RV": "pic/regn.png",
    "63-RE": "pic/regn.png",
    "64-EC": "pic/RJ.png",
    "64-EN": "pic/NJ.png",
    "77-EXP": "pic/TTI.svg",
    "ITALO-AV": "pic/italo.svg"
};

window.CLIENT_LINK_MAP = CLIENT_LINK_MAP;
window.CAT_IMAGE_MAP = CAT_IMAGE_MAP;
window.CAT_MAP = CAT_MAP;
/**
 * 根据列车类别代码返回对应的 badge CSS 类名。
 * 集中管理，供 main.ts 和 station.ts 共同使用。
 */
window.getBadgeClass = function (catCode) {
    if (catCode === 'AV') return 'badge-italo';
    if (['REG', 'RE', 'RV', 'MET'].includes(catCode)) return 'badge-regional';
    if (['FR', 'FB', 'FA'].includes(catCode)) return 'badge-arrow';
    if (['IC', 'ICN'].includes(catCode)) return 'badge-intercity';
    if (['EC', 'EN'].includes(catCode)) return 'badge-international';
    if (catCode === 'NCL') return 'badge-ncl';
    if (catCode === 'TS') return 'badge-storico';
    if (catCode === 'EXP') return 'badge-espresso';
    return '';
};
