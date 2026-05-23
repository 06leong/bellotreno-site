export const lakes = [];

export const terrainBlobs = [];

export const routes = [
    {
        id: 'torino-fr',
        type: 'fr',
        points: [[790, 512], [650, 512], [500, 512], [345, 492], [-80, 492]],
    },
    {
        id: 'torino-ic',
        type: 'ic',
        points: [[790, 532], [650, 532], [500, 532], [345, 512], [-80, 512]],
    },
    {
        id: 'torino-reg',
        type: 'reg',
        points: [[790, 552], [650, 552], [500, 552], [345, 532], [-80, 532]],
    },
    {
        id: 'varese-reg',
        type: 'reg',
        points: [[782, 502], [690, 425], [560, 315], [420, 230], [250, 135], [-70, -50]],
    },
    {
        id: 'chiasso-reg',
        type: 'reg',
        points: [[795, 500], [795, 410], [765, 300], [730, 205], [690, 100], [650, -70]],
    },
    {
        id: 'chiasso-ec',
        type: 'ec',
        points: [[815, 500], [815, 410], [785, 300], [750, 205], [710, 100], [670, -70]],
    },
    {
        id: 'lecco-reg',
        type: 'reg',
        points: [[835, 500], [930, 430], [1060, 330], [1210, 225], [1370, 125], [1650, -45]],
    },
    {
        id: 'verona-fr',
        type: 'fr',
        points: [[840, 512], [995, 512], [1160, 502], [1330, 502], [1680, 502]],
    },
    {
        id: 'verona-reg',
        type: 'reg',
        points: [[840, 532], [995, 532], [1160, 522], [1330, 522], [1680, 522]],
    },
    {
        id: 'bologna-fr',
        type: 'fr',
        points: [[824, 546], [930, 652], [1050, 772], [1190, 912], [1390, 1112]],
    },
    {
        id: 'bologna-ic',
        type: 'ic',
        points: [[810, 546], [916, 666], [1036, 786], [1176, 926], [1376, 1126]],
    },
    {
        id: 'bologna-reg',
        type: 'reg',
        points: [[796, 546], [902, 680], [1022, 800], [1162, 940], [1362, 1140]],
    },
    {
        id: 'genova-ic',
        type: 'ic',
        points: [[788, 554], [680, 662], [560, 782], [430, 912], [150, 1092]],
    },
    {
        id: 'genova-reg',
        type: 'reg',
        points: [[774, 540], [666, 648], [546, 768], [416, 898], [136, 1078]],
    },
];

export const nodes = [
    { id: 'torino', x: 130, y: 512, size: 'normal' },
    { id: 'novara', x: 345, y: 512, size: 'normal' },
    { id: 'rho', x: 635, y: 532, size: 'normal' },
    { id: 'saronno', x: 560, y: 315, size: 'normal' },
    { id: 'gallarate', x: 420, y: 230, size: 'normal' },
    { id: 'varese', x: 250, y: 135, size: 'normal' },
    { id: 'como', x: 768, y: 300, size: 'normal' },
    { id: 'chiasso', x: 713, y: 105, size: 'normal' },
    { id: 'monza', x: 930, y: 430, size: 'normal' },
    { id: 'lecco', x: 1060, y: 330, size: 'normal' },
    { id: 'sondrio', x: 1370, y: 125, size: 'normal' },
    { id: 'treviglio', x: 995, y: 512, size: 'normal' },
    { id: 'brescia', x: 1330, y: 502, size: 'normal' },
    { id: 'verona', x: 1510, y: 502, size: 'normal' },
    { id: 'lodi', x: 916, y: 666, size: 'normal' },
    { id: 'piacenza', x: 1036, y: 786, size: 'normal' },
    { id: 'bologna', x: 1376, y: 1126, size: 'normal' },
    { id: 'pavia', x: 680, y: 662, size: 'normal' },
    { id: 'voghera', x: 560, y: 782, size: 'normal' },
    { id: 'genova', x: 150, y: 1092, size: 'normal' },
];

export const interchanges = [
    { x: 760, y: 502, width: 92, height: 54, rx: 18 },
];
