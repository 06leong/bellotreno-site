/**
 * BelloTreno Configuration
 */

window.API_BASE = "https://ah.bellotreno.workers.dev/?url=https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";
window.NOTIFY_BASE = "https://notify.bellotreno.workers.dev";

const CLIENT_MAP = {
    1: "Trenitalia",
    2: "Trenitalia",
    4: "Trenitalia",
    18: "Trenitalia TPER",
    77: "FS Treni Turistici Italiani",
    910: "Ferrovie del Sud Est",
    63: "Trenord",
    64: "ÖBB"
};
window.CLIENT_MAP = CLIENT_MAP;

const CLIENT_LINK_MAP = {
    "Trenitalia": "https://www.trenitalia.com",
    "Trenitalia TPER": "https://www.trenitaliatper.it",
    "Ferrovie del Sud Est": "https://www.trenitalia.com",
    "Trenord": "https://www.trenord.it",
    "ÖBB": "https://www.oebb.at",
    "FS Treni Turistici Italiani": "https://www.fstrenituristici.it"
};

const CAT_MAP = {
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
    "TS": "Treno Storico",
    "EXP": "Espresso"
};

const CAT_IMAGE_MAP = {
    "1-IC": "pic/IC.png",
    "2-IC": "pic/IC.png",
    "4-IC": "pic/IC.png",
    "1-ICN": "pic/ICN.png",
    "2-ICN": "pic/ICN.png",
    "4-ICN": "pic/ICN.png",
    "1-REG": "pic/RV.png",
    "2-REG": "pic/RV.png",
    "4-REG": "pic/RV.png",
    "1-RV": "pic/RV.png",
    "2-RV": "pic/RV.png",
    "4-RV": "pic/RV.png",
    "1-MET": "pic/RV.png",
    "2-MET": "pic/RV.png",
    "4-MET": "pic/RV.png",
    "1-RE": "pic/RV.png",
    "2-RE": "pic/RV.png",
    "4-RE": "pic/RV.png",
    "1-FR": "pic/FR.png",
    "2-FR": "pic/FR.png",
    "4-FR": "pic/FR.png",
    "1-FA": "pic/FA.png",
    "2-FA": "pic/FA.png",
    "4-FA": "pic/FA.png",
    "1-FB": "pic/FB.png",
    "2-FB": "pic/FB.png",
    "4-FB": "pic/FB.png",
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
    "18-RV": "pic/regn.png",
    "18-RE": "pic/regn.png",
    "910-REG": "pic/regn.png",
    "910-RV": "pic/regn.png",
    "910-RE": "pic/regn.png",
    "63-REG": "pic/regn.png",
    "63-RV": "pic/regn.png",
    "63-RE": "pic/regn.png",
    "64-EC": "pic/RJ.png",
    "64-EN": "pic/NJ.png",
    "77-EXP": "pic/TTI.png"
};
