/**
 * Where macOS draws the window's close, minimise and zoom buttons over the page: three 12 px
 * buttons 8 px apart, so they span 52 px from `x` and their centre is 6 px below `y`. The centre
 * is 24 px down, the middle of the sidebar's 48 px title row and of the conversation's header
 * band (`--header-height` in `src/style.css`); `--traffic-lights` there is the room they take.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 };
