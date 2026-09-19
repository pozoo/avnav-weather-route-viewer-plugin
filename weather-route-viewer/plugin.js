/*
 * AvNav weather route viewer.
 * Loads a weather-routing GPX (route points with times and wind/boat/wave
 * data in the urn:weather-router:gpx:2 extension namespace) as a reference
 * route and draws it on the chart with a boat marker that follows time.
 *
 * Legacy plugin API only (avnav.api.registerWidget). One IIFE, no modules,
 * no build step - this file is loaded as a plain <script>.
 */
(function () {
    'use strict';

    var WR_NS = 'urn:weather-router:gpx:2';

    // -----------------------------------------------------------------
    // module state - shared between the map widget, the scrub control and
    // the detail widget. Kept here (not in a widget context) because all
    // of them need to see/change the same route & time.
    // -----------------------------------------------------------------
    var state = {
        route: null,          // parsed route, see parseGpx()
        routeFile: null,      // requested file name ('' = first .gpx), null before the first load
        loadedFile: null,     // name of the file actually loaded
        loadedTime: null,     // its modification time from /api/user/list
        loadedSize: null,     // its size from /api/user/list
        loading: false,
        loadError: null,
        selectedIndex: 0,     // waypoint index selected by the scrub control
        mode: 'live',         // 'live' | 'scrub'
        hidden: false,        // route display switched off from the control
        scrubTime: null,      // time of the selected waypoint while scrubbing
        lastRenderProps: null, // last props seen by drawRoute(), for inspection
        lastStyle: null
    };

    var contexts = [];        // registered widget contexts, for notify()
    var loadGeneration = 0;

    function registerContext(context) {
        if (context && contexts.indexOf(context) === -1) contexts.push(context);
    }

    function unregisterContext(context) {
        var idx = contexts.indexOf(context);
        if (idx !== -1) contexts.splice(idx, 1);
        if (!contexts.length) stopTimer();
    }

    // re-renders every registered widget context - called whenever state
    // that affects drawing changes (route loaded, timer tick, scrubbing)
    function notify() {
        contexts.forEach(function (context) {
            if (!context) return;
            if (typeof context.triggerRender === 'function') context.triggerRender();
            else if (typeof context.triggerRedraw === 'function') context.triggerRedraw();
        });
    }

    // -----------------------------------------------------------------
    // time helpers
    // -----------------------------------------------------------------

    // live time comes from the store (nav.gps.rtime) when available,
    // otherwise the browser clock. Scrub mode overrides it in
    // getDisplayTime() - keep all reads going through that.
    // nav.gps.rtime arrives as a JS Date object (confirmed against the
    // viewer bundle), but accept a plain epoch-seconds number too.
    function getLiveTime(props) {
        var r = props && props.rtime;
        if (r instanceof Date) return r.getTime() / 1000;
        if (typeof r === 'number' && !isNaN(r)) return r;
        return Date.now() / 1000;
    }

    function getDisplayTime(props) {
        if (state.mode === 'scrub' && typeof state.scrubTime === 'number') return state.scrubTime;
        return getLiveTime(props);
    }

    // -----------------------------------------------------------------
    // scrub control - pure stepping logic plus the module
    // state transitions it drives. Kept next to the time helpers because
    // it is really just another way of picking "the displayed time".
    // -----------------------------------------------------------------

    function clampIndex(index, length) {
        if (!length || length < 1) return 0;
        if (index < 0) return 0;
        if (index > length - 1) return length - 1;
        return index;
    }

    // one step of ◀/▶, clamped at both ends of the route. Pure function,
    // no module state.
    function stepIndex(current, delta, length) {
        return clampIndex(current + delta, length);
    }

    // the waypoint index the boat is currently closest to, for adopting
    // a starting point when scrubbing is entered from live mode.
    function nearestIndex(route, time) {
        var pts = route && route.points;
        if (!pts || !pts.length) return 0;
        var interp = interpolate(route, time);
        if (!interp) return 0;
        return clampIndex(Math.round(interp.index + interp.frac), pts.length);
    }

    // enters/stays in scrub mode at a given waypoint index and redraws.
    function selectWaypoint(index) {
        var pts = state.route && state.route.points;
        if (!pts || !pts.length) return;
        index = clampIndex(index, pts.length);
        state.mode = 'scrub';
        state.selectedIndex = index;
        state.scrubTime = pts[index].t;
        notify();
    }

    // ◀ / ▶ : from live mode this first adopts the waypoint the boat is
    // currently at, then steps from there - so the first click never
    // jumps back to waypoint 0.
    function scrubStep(delta, props) {
        var pts = state.route && state.route.points;
        if (!pts || !pts.length) return;
        // while the display is off the first press only brings it back -
        // stepping a waypoint at the same time would move the route the
        // moment it reappears, which is not what the press asked for.
        if (state.hidden) {
            state.hidden = false;
            notify();
            return;
        }
        var current = state.mode === 'scrub' ? state.selectedIndex : nearestIndex(state.route, getLiveTime(props));
        selectWaypoint(stepIndex(current, delta, pts.length));
    }

    // back to the current-time boat position, display on.
    function goLive() {
        state.hidden = false;
        state.mode = 'live';
        notify();
    }

    // the LIVE button. Pressing it while already live switches the route
    // display off - a route that is only a reference should be easy to get
    // out of the way without editing the layout. Any button then brings it
    // back: LIVE here, the arrows in scrubStep().
    function liveButton() {
        if (!state.hidden && state.mode === 'live') {
            state.hidden = true;
            notify();
            return;
        }
        goLive();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function hasFormatter(name) {
        return typeof avnav !== 'undefined' && avnav && avnav.api && avnav.api.formatter &&
            typeof avnav.api.formatter[name] === 'function';
    }

    // Times are shown in the browser's local time zone, like every other
    // AvNav widget - not the GPX's own UTC timestamps. Delegates to AvNav's
    // own formatter when available (so the plugin automatically follows
    // whatever convention AvNav itself uses); the pure fallback - used when
    // there is no avnav.api - reproduces the same
    // "HH:MM" from the Date object's local getters.
    function formatClock(t) {
        var d = new Date(t * 1000);
        if (hasFormatter('formatClock')) return avnav.api.formatter.formatClock(d);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    // short date prefix shown on a label when it crosses a local-midnight
    // boundary from the previous one - AvNav's own ordering is month/day.
    function formatDateShort(t) {
        var d = new Date(t * 1000);
        return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
    }

    // local calendar day, used to detect when consecutive labels cross
    // midnight in the viewer's own time zone (not UTC).
    function dayKey(t) {
        var d = new Date(t * 1000);
        return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    }

    // -----------------------------------------------------------------
    // angle helpers
    // -----------------------------------------------------------------

    function normalizeAngle(deg) {
        deg = deg % 360;
        if (deg < 0) deg += 360;
        return deg;
    }

    // -----------------------------------------------------------------
    // GPX parsing
    // -----------------------------------------------------------------

    function setNumNS(target, key, parent, tag) {
        if (!parent) return;
        var node = parent.getElementsByTagNameNS(WR_NS, tag)[0];
        if (!node) return;
        var v = parseFloat(node.textContent);
        if (!isNaN(v)) target[key] = v;
    }

    function parsePoint(el) {
        var p = {};
        var lat = parseFloat(el.getAttribute('lat'));
        var lon = parseFloat(el.getAttribute('lon'));
        if (!isNaN(lat)) p.lat = lat;
        if (!isNaN(lon)) p.lon = lon;
        var timeEl = el.getElementsByTagName('time')[0];
        if (timeEl && timeEl.textContent) {
            var t = Date.parse(timeEl.textContent) / 1000;
            if (!isNaN(t)) p.t = t;
        }
        var forecast = el.getElementsByTagNameNS(WR_NS, 'forecast')[0];
        if (forecast) {
            ['gws', 'gwd', 'gust', 'swh', 'wavePeriod', 'waveDir', 'curSpeed', 'curSet'].forEach(function (tag) {
                setNumNS(p, tag, forecast, tag);
            });
        }
        var boat = el.getElementsByTagNameNS(WR_NS, 'boat')[0];
        if (boat) {
            ['tws', 'twd', 'stw', 'sog', 'ctw', 'cog', 'twa', 'awa', 'aws'].forEach(function (tag) {
                setNumNS(p, tag, boat, tag);
            });
            var nightEl = boat.getElementsByTagNameNS(WR_NS, 'night')[0];
            if (nightEl && nightEl.textContent !== '') p.night = parseFloat(nightEl.textContent) === 1;
            var engineEl = boat.getElementsByTagNameNS(WR_NS, 'engine')[0];
            if (engineEl && engineEl.textContent !== '') p.engine = parseFloat(engineEl.textContent) === 1;
            var maneuverEl = boat.getElementsByTagNameNS(WR_NS, 'maneuver')[0];
            if (maneuverEl && maneuverEl.textContent) p.maneuver = maneuverEl.textContent;
        }
        return p;
    }

    // the per-point fields the whole route actually carries. Routes exported
    // by a router that only writes plain waypoints (LuckGrib and the like)
    // have none of them - the detail widget then leaves those lines out
    // instead of showing a column of dashes, see routePointRows().
    function availableFields(points) {
        var available = {};
        points.forEach(function (p) {
            if (!p) return;
            Object.keys(p).forEach(function (k) {
                if (p[k] !== null && p[k] !== undefined) available[k] = true;
            });
        });
        return available;
    }

    // parses the GPX into {name, units, settings, points[], available,
    // start, end}. Prefers <rte>, falls back to <trk>. Missing fields are
    // simply absent.
    function parseGpx(xmlText) {
        var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        var units = {};
        var unitsEl = doc.getElementsByTagNameNS(WR_NS, 'units')[0];
        if (unitsEl && unitsEl.attributes) {
            for (var i = 0; i < unitsEl.attributes.length; i++) {
                var attr = unitsEl.attributes[i];
                units[attr.name] = attr.value;
            }
        }
        // route-level settings: every numeric wr: element directly under
        // <metadata><extensions> (motorSpeed, motorBelowTws, ...). Parsed
        // generically so a new setting arrives without a parser change.
        var settings = {};
        var metadata = doc.getElementsByTagName('metadata')[0];
        var metaExt = metadata && metadata.getElementsByTagName('extensions')[0];
        if (metaExt) {
            var children = metaExt.childNodes;
            for (var c = 0; c < children.length; c++) {
                var child = children[c];
                if (child.nodeType !== 1 || child.namespaceURI !== WR_NS) continue;
                var localName = child.localName || child.nodeName.replace(/^wr:/, '');
                if (localName === 'units') continue;
                var parsed = parseFloat(child.textContent);
                if (!isNaN(parsed)) settings[localName] = parsed;
            }
        }
        var container = doc.getElementsByTagName('rte')[0];
        var tagName = 'rtept';
        if (!container) {
            container = doc.getElementsByTagName('trk')[0];
            tagName = 'trkpt';
        }
        var name = '';
        var points = [];
        if (container) {
            var nameEl = container.getElementsByTagName('name')[0];
            if (nameEl) name = nameEl.textContent;
            var pts = container.getElementsByTagName(tagName);
            for (var j = 0; j < pts.length; j++) points.push(parsePoint(pts[j]));
        }
        var route = { name: name, units: units, settings: settings, points: points,
            available: availableFields(points) };
        if (points.length) {
            route.start = points[0].t;
            route.end = points[points.length - 1].t;
        }
        return route;
    }

    // -----------------------------------------------------------------
    // time -> position interpolation
    // -----------------------------------------------------------------

    // initial great-circle bearing from a to b, in degrees. Used as the
    // fallback heading for a leg whose start point carries no cog.
    function bearing(a, b) {
        var lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
        var dLon = (b.lon - a.lon) * Math.PI / 180;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        return normalizeAngle(Math.atan2(y, x) * 180 / Math.PI);
    }

    // the heading of the leg that starts at points[i]. A waypoint's own cog
    // describes the leg LEAVING it - verified against the sample route, where
    // it matches the leg's geometric bearing to within 0.2 deg, while the
    // next point's cog belongs to the next leg and differs by up to 127 deg
    // at a tack. So the heading is constant along a leg and must NOT be
    // interpolated between the two ends: doing that swung the boat marker
    // through a course it never sails whenever it approached a tack.
    function legHeading(points, index) {
        var a = points[index];
        if (!a) return undefined;
        if (typeof a.cog === 'number' && !isNaN(a.cog)) return a.cog;
        var b = points[index + 1];
        return b ? bearing(a, b) : undefined;
    }

    function boundaryResult(points, index) {
        var p = points[index];
        // at the far end there is no leg starting here any more - keep the
        // heading of the last leg the boat actually sailed
        var headingIndex = (index >= points.length - 1) ? points.length - 2 : index;
        return {
            lat: p.lat, lon: p.lon,
            cog: legHeading(points, headingIndex < 0 ? 0 : headingIndex),
            index: index, frac: 0
        };
    }

    // interpolates lat/lon/cog for time t along route.points. Clamps to the
    // first/last point outside the route's time range. index+frac together
    // give a continuous "position along the route" used to split the drawn
    // polyline exactly at the boat.
    function interpolate(route, t) {
        var pts = route && route.points;
        if (!pts || !pts.length) return null;
        if (pts.length === 1) return boundaryResult(pts, 0);
        var first = pts[0], last = pts[pts.length - 1];
        if (first.t != null && t <= first.t) return boundaryResult(pts, 0);
        if (last.t != null && t >= last.t) return boundaryResult(pts, pts.length - 1);
        for (var i = 0; i < pts.length - 1; i++) {
            var a = pts[i], b = pts[i + 1];
            if (a.t == null || b.t == null) continue;
            // strictly less than b.t: landing exactly on b means being AT
            // waypoint b, handled by the next iteration, so the heading there is
            // the leg b leaves on rather than the one it arrives by
            if (t >= a.t && t < b.t) {
                var span = b.t - a.t;
                var frac = span > 0 ? (t - a.t) / span : 0;
                var res = {
                    lat: a.lat + (b.lat - a.lat) * frac,
                    lon: a.lon + (b.lon - a.lon) * frac,
                    index: i,
                    frac: frac
                };
                // constant along the leg - see legHeading()
                res.cog = legHeading(pts, i);
                return res;
            }
        }
        return boundaryResult(pts, pts.length - 1);
    }

    // -----------------------------------------------------------------
    // decluttering: keeps a point only if it is at least minDist away
    // (in the same units as the point coordinates) from the last kept one.
    // Used both for waypoint markers (~14 device px) and time labels
    // (~70 device px), each with its own pass / own "last drawn" tracking.
    // -----------------------------------------------------------------

    function pxDist(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    function declutter(points, minDist) {
        var kept = [];
        var last = null;
        for (var i = 0; i < points.length; i++) {
            var p = points[i];
            if (last === null || pxDist(p, last) >= minDist) {
                kept.push(i);
                last = p;
            }
        }
        return kept;
    }

    // -----------------------------------------------------------------
    // wind barbs - pure logic, no canvas needed.
    // Standard meteorological barb: speed rounded to the nearest 5 kn,
    // decomposed into 50 kn pennants, 10 kn full barbs and 5 kn half
    // barbs. Below 2.5 kn there is nothing to decompose - that is the
    // distinct "calm" case, drawn as a circle instead of a shaft.
    // -----------------------------------------------------------------

    function barbFeathers(speedKn) {
        var s = speedKn == null || isNaN(speedKn) ? 0 : Math.max(0, speedKn);
        if (s < 2.5) return { calm: true, pennants: 0, full: 0, half: 0, speed: 0 };
        var rounded = Math.round(s / 5) * 5;
        var pennants = Math.floor(rounded / 50);
        var rem = rounded - pennants * 50;
        var full = Math.floor(rem / 10);
        rem -= full * 10;
        var half = rem >= 5 ? 1 : 0;
        return { calm: false, pennants: pennants, full: full, half: half, speed: rounded };
    }

    // turns a {pennants,full,half} decomposition into a list of shapes in
    // local barb coordinates: the shaft runs from the station point (0,0)
    // to the tip (0,-shaftLen) - i.e. "up" before the caller rotates it to
    // the true direction the wind comes from, same convention drawBoat()
    // uses for cog. Feathers are attached starting at the tip (the biggest
    // units outermost, per convention) and step back towards the station,
    // all on the same side. Calm returns a single circle, no shaft.
    // Pure geometry - no canvas calls.
    // Proportions and layout follow the standard meteorological construction
    // (same as matplotlib's reference implementation): everything is relative
    // to the staff length - barbs reach 0.4 of it sideways, a pennant is 0.25
    // of it wide along the staff, elements are 0.125 apart, and the calm
    // circle has radius 0.15.
    //
    // Elements are laid out from the TIP of the staff inwards: pennants
    // first (outermost), then full barbs, then the half barb. Barbs slant
    // forward, towards the tip - not back towards the station. A lone half
    // barb is set in from the tip by 1.5 spacings, so that 5 kn cannot be
    // mistaken for 10 kn.
    function barbGeometry(feathers, opts) {
        opts = opts || {};
        var scale = opts.scale || 1;
        var shaftLen = (opts.shaftLen || 26) * scale;
        if (feathers.calm) {
            var r = opts.calmRadius != null ? opts.calmRadius * scale : shaftLen * 0.15;
            return { shapes: [{ type: 'circle', cx: 0, cy: 0, r: r }] };
        }
        var side = opts.side == null ? 1 : opts.side;
        var spacing = shaftLen * (opts.spacing || 0.125);
        var height = shaftLen * (opts.height || 0.4);    // sideways reach
        var width = shaftLen * (opts.width || 0.25);     // extent along the staff

        // distance from the station along the staff; the tip is at shaftLen,
        // and the point at distance d has the coordinates (0, -d)
        var offset = shaftLen;
        var shapes = [{ type: 'line', points: [[0, 0], [0, -shaftLen]] }];
        var i;
        for (i = 0; i < feathers.pennants; i++) {
            // the barb spacing is a little too much between two pennants
            if (offset !== shaftLen) offset -= spacing / 2;
            shapes.push({
                type: 'poly',
                points: [[0, -offset],
                         [side * height, -offset + width / 2],
                         [0, -offset + width]]
            });
            offset -= width + spacing;
        }
        for (i = 0; i < feathers.full; i++) {
            shapes.push({
                type: 'line',
                points: [[0, -offset], [side * height, -offset - width / 2]]
            });
            offset -= spacing;
        }
        if (feathers.half) {
            // a half barb on its own is set in from the tip so it cannot be
            // confused with a full barb
            if (offset === shaftLen) offset -= 1.5 * spacing;
            shapes.push({
                type: 'line',
                points: [[0, -offset], [side * height / 2, -offset - width / 4]]
            });
        }
        return { shapes: shapes };
    }

    // -----------------------------------------------------------------
    // WRRoutePoint - pure point-to-rows logic, no DOM needed.
    // Turns one route point into the compact fields the detail widget
    // shows, degrading missing values to a dash rather than NaN/undefined.
    // -----------------------------------------------------------------

    var DASH = '–';

    // fallback units, used whenever the GPX's own <wr:units> is missing a
    // key (or the whole block is absent) - keeps the widget useful even
    // against a hand-edited or older GPX.
    var DEFAULT_UNITS = {
        twd: 'deg', tws: 'kn', gust: 'kn', gwd: 'deg', gws: 'kn',
        swh: 'm', wavePeriod: 's', waveDir: 'deg',
        curSpeed: 'kn', curSet: 'deg',
        stw: 'kn', sog: 'kn', twa: 'deg', awa: 'deg', aws: 'kn', cog: 'deg', ctw: 'deg',
        motorSpeed: 'kn', motorBelowTws: 'kn'
    };

    // raw GPX/default unit text (used as-is for direction/decimal fields,
    // and as the fallback for speed fields when AvNav itself cannot tell us
    // what it actually rendered - see speedUnitSuffix() below).
    function rawUnitSuffix(raw) {
        if (raw === 'deg') return '°';
        return raw ? ' ' + raw : '';
    }

    function unitSuffix(units, key) {
        return rawUnitSuffix((units && units[key]) || DEFAULT_UNITS[key] || '');
    }

    // formatSpeed has no global "user unit" setting to read (AvNav has none -
    // the display unit is whatever gets passed as its own "unit" formatter
    // parameter, defaulting to knots when none is given, exactly like our
    // own fmtSpeedNum() call below). So the one way to guarantee the suffix
    // always matches the number formatSpeed actually produced is to ask
    // formatSpeed itself, via unitFromParameters(), with the very same
    // (empty) parameter list used to render the number - never derive it
    // from the GPX's own declared unit, which need not agree.
    // Falls back to the GPX/default unit text when there is no avnav.api
    // or this AvNav build predates unitFromParameters.
    function speedUnitSuffix(rawUnit) {
        if (hasFormatter('formatSpeed') && typeof avnav.api.formatter.formatSpeed.unitFromParameters === 'function') {
            var u = avnav.api.formatter.formatSpeed.unitFromParameters([]);
            if (u) return ' ' + u;
        }
        return rawUnitSuffix(rawUnit);
    }

    // direction/speed/decimal fields go through avnav.api.formatter when
    // it exists, so they follow the user's own unit/decimal settings just
    // like AvNav's own widgets - each with a pure fallback (used when there
    // is no avnav.api) that reproduces the exact
    // rounding this widget used before the formatter existed.
    function fmtDirectionNum(v) {
        if (hasFormatter('formatDirection')) return avnav.api.formatter.formatDirection(v).trim();
        return String(Math.round(v));
    }

    // avnav.api.formatter.formatSpeed expects its input in m/s (AvNav's own
    // internal/SI unit for speed, confirmed against the viewer bundle's own
    // knots conversion) and converts it to the user's chosen display unit -
    // so a value in any other unit (the GPX's own wr:units, normally "kn")
    // must be converted to m/s first, or the formatter silently reports the
    // wrong number (kn fed in as if it were m/s comes out ~1.94x too high).
    var SPEED_TO_MS = { kn: 1852 / 3600, 'km/h': 1 / 3.6, 'm/s': 1, mph: 0.44704 };

    function fmtSpeedNum(v, decimals, rawUnit) {
        if (hasFormatter('formatSpeed')) {
            var factor = SPEED_TO_MS[rawUnit] || SPEED_TO_MS.kn;
            return avnav.api.formatter.formatSpeed(v * factor).trim();
        }
        return decimals ? v.toFixed(decimals) : String(Math.round(v));
    }

    function fmtDecimalNum(v, decimals) {
        if (hasFormatter('formatDecimal')) return avnav.api.formatter.formatDecimal(v, 3, decimals).trim();
        return v.toFixed(decimals);
    }

    // which formatter kind each field uses, and the fallback decimal count
    // (only relevant for speed/decimal - direction is always a whole degree).
    var FIELD_KIND = {
        twd: 'dir', twa: 'dir', waveDir: 'dir',
        gwd: 'dir', awa: 'dir', cog: 'dir', ctw: 'dir', curSet: 'dir',
        tws: 'speed', gust: 'speed', stw: 'speed', sog: 'speed',
        gws: 'speed', aws: 'speed', motorSpeed: 'speed', motorBelowTws: 'speed',
        curSpeed: 'speed',
        swh: 'dec', wavePeriod: 'dec'
    };
    var FIELD_DECIMALS = {
        tws: 1, gust: 0, stw: 1, sog: 1, gws: 1, aws: 1, swh: 1, wavePeriod: 1,
        motorSpeed: 1, motorBelowTws: 1, curSpeed: 1
    };

    // formats one numeric field as "<value><unit suffix>", or a dash when
    // the field is missing/NaN - the one place that degradation happens.
    function fmtField(point, key, units) {
        var v = point ? point[key] : null;
        if (typeof v !== 'number' || isNaN(v)) return DASH;
        var kind = FIELD_KIND[key] || 'dec';
        var decimals = FIELD_DECIMALS[key] == null ? 1 : FIELD_DECIMALS[key];
        if (kind === 'speed') {
            var rawUnit = (units && units[key]) || DEFAULT_UNITS[key];
            return fmtSpeedNum(v, decimals, rawUnit) + speedUnitSuffix(rawUnit);
        }
        var numStr = kind === 'dir' ? fmtDirectionNum(v) : fmtDecimalNum(v, decimals);
        return numStr + unitSuffix(units, key);
    }

    function capitalize(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    // splits a formatted value ("15.0 kn", "251°", "–") into the number and
    // its unit, so the detail widget can right-align every number in one
    // column and left-align every unit in the next. Pure.
    function splitValue(text) {
        if (text == null) return { num: DASH, unit: '' };
        var str = String(text).trim();
        var deg = /^(.*?)\s*°$/.exec(str);
        if (deg) return { num: deg[1], unit: '°' };
        var idx = str.lastIndexOf(' ');
        if (idx > 0) return { num: str.substring(0, idx), unit: str.substring(idx + 1) };
        return { num: str, unit: '' };
    }

    // the waypoint fields a router can supply, in no particular order - used
    // to tell a route that carries data from one that is positions and times
    // only. Flags (night/engine/maneuver) are not in here: they show up as
    // flag labels, not as lines, and are absent on such a route anyway.
    var DATA_FIELDS = ['gws', 'gwd', 'tws', 'gust', 'twd', 'twa', 'aws', 'awa',
        'stw', 'ctw', 'sog', 'cog', 'swh', 'wavePeriod', 'waveDir', 'curSpeed', 'curSet'];

    // turns a route point into the fields the WRRoutePoint widget displays:
    // an ordered list of {label, value, num, unit} plus a separate list of
    // flag labels that are only present when actually set on the point.
    // One value per line - a narrow widget column cannot hold a label plus
    // two values, and iOS inflates small text further. Every line can be
    // switched off individually in the layout editor; the waypoint number and
    // its time default to off because the scrub control already shows both.
    function routePointRows(point, units, index, total, opts, settings, available) {
        point = point || {};
        settings = settings || {};
        opts = opts || {};
        var on = function (key, dflt) {
            return opts[key] === undefined ? dflt : opts[key] !== false;
        };
        // `available` (route.available) lists the fields the route carries at
        // all; without it nothing is filtered, so a caller that does not know
        // the route gets every switched-on line as before.
        var has = function (name) { return !available || !!available[name]; };
        var fields = [];
        var push = function (label, value) {
            var parts = splitValue(value);
            fields.push({ label: label, value: value, num: parts.num, unit: parts.unit });
        };
        var add = function (key, dflt, label, value) {
            if (on(key, dflt)) push(label, value);
        };
        var num = function (name) { return fmtField(point, name, units); };
        // a waypoint field: dropped when no point of the route has it
        var addNum = function (key, dflt, label, name) {
            if (has(name)) add(key, dflt, label, num(name));
        };
        // a route-level setting from the GPX metadata - same everywhere, so
        // it is dropped when the metadata does not carry it
        var addSetting = function (key, label, name) {
            if (!available || settings[name] != null) add(key, false, label, fmtField(settings, name, units));
        };

        // the layout editor lists its switches (routePointParameters) in
        // exactly the same order as the lines below.
        // "n/total", not formatWaypointLabel()'s "WP n/total" - the label
        // cell already reads "WP".
        add('showWp', false, 'WP', (index || 0) + 1 + '/' + (total || 0));
        add('showTime', false, 'Time', point.t != null ? formatClock(point.t) : DASH);
        // ground wind: the forecast wind over ground. Equals the true wind
        // unless the router worked with current, hence off by default.
        addNum('showGws', false, 'GWS', 'gws');
        addNum('showGwd', false, 'GWD', 'gwd');
        // true wind
        addNum('showTws', true, 'TWS', 'tws');
        addNum('showGust', true, 'Gust', 'gust');
        addNum('showTwd', true, 'TWD', 'twd');
        addNum('showTwa', true, 'TWA', 'twa');
        // apparent wind
        addNum('showAws', false, 'AWS', 'aws');
        addNum('showAwa', false, 'AWA', 'awa');
        // the boat: speed and course, through water and over ground
        addNum('showStw', true, 'STW', 'stw');
        addNum('showCtw', false, 'CTW', 'ctw');
        addNum('showSog', true, 'SOG', 'sog');
        addNum('showCog', false, 'COG', 'cog');
        // waves
        addNum('showSwh', true, 'SWH', 'swh');
        addNum('showPeriod', true, 'Period', 'wavePeriod');
        addNum('showWaveDir', true, 'Wave dir', 'waveDir');
        // current: speed ("drift") and the direction it sets towards
        addNum('showCurSpeed', false, 'Cur', 'curSpeed');
        addNum('showCurSet', false, 'Set', 'curSet');
        // route-level settings from the GPX metadata - the same for every
        // waypoint, so they are off by default
        addSetting('showMotorSpeed', 'Motor', 'motorSpeed');
        addSetting('showMotorBelowTws', 'Motor <', 'motorBelowTws');

        // a route with positions and times only (a plain GPX export) has no
        // line left at this point - the widget would be an empty box, so it
        // falls back to the waypoint and its time. A route that does carry
        // data keeps showing exactly what the switches say, empty included.
        if (!fields.length && available && !DATA_FIELDS.some(has) && point.t != null) {
            push('WP', (index || 0) + 1 + '/' + (total || 0));
            push('Time', formatClock(point.t));
        }

        var flags = [];
        if (on('showFlags', true)) {
            if (point.maneuver) flags.push(capitalize(point.maneuver));
            if (point.night) flags.push('Night');
            if (point.engine) flags.push('Engine');
        }

        return { fields: fields, flags: flags };
    }

    // -----------------------------------------------------------------
    // maneuver/engine/night metadata - pure grouping logic.
    // -----------------------------------------------------------------

    // groups indices of `points` into contiguous runs where point[flagKey]
    // is truthy, e.g. flagRuns(points, 'engine') -> [{start,end}, ...].
    // Handles runs touching either end and single-point runs.
    function flagRuns(points, flagKey) {
        var runs = [];
        var runStart = null;
        for (var i = 0; i < points.length; i++) {
            var on = !!(points[i] && points[i][flagKey]);
            if (on && runStart === null) runStart = i;
            if (!on && runStart !== null) {
                runs.push({ start: runStart, end: i - 1 });
                runStart = null;
            }
        }
        if (runStart !== null) runs.push({ start: runStart, end: points.length - 1 });
        return runs;
    }

    // -----------------------------------------------------------------
    // version-dependent canvas rotation:
    // from 20260104 on, the map canvas is pre-rotated - north-referenced
    // shapes need no extra rotation, text needs -getRotation(). Before
    // that it is the other way round.
    // -----------------------------------------------------------------

    function isPreRotatedVersion(versionString) {
        var v = parseInt(versionString, 10);
        if (isNaN(v)) return false;
        return v >= 20260104;
    }

    function isPreRotated() {
        if (typeof avnav === 'undefined' || !avnav || !avnav.api || !avnav.api.getAvNavVersion) return false;
        return isPreRotatedVersion(avnav.api.getAvNavVersion());
    }

    // angle (radians) to rotate a north-referenced shape (e.g. the boat
    // marker) drawn with "up" = 0 degrees true.
    function shapeRotation(trueBearingRad, mapRotationRad, preRotated) {
        return preRotated ? trueBearingRad : trueBearingRad + mapRotationRad;
    }

    // extra rotation (radians) needed to keep text upright.
    function textRotation(mapRotationRad, preRotated) {
        return preRotated ? -mapRotationRad : 0;
    }

    // -----------------------------------------------------------------
    // drawing (browser only)
    // -----------------------------------------------------------------

    // colours with no AvNav equivalent (barbs, maneuver glyphs, start/end
    // markers) - everything else is sourced from AvNav's
    // own store properties per render, see resolveStyle() below.
    var STATIC_STYLE = {
        start: '#2e8b2e',
        end: '#b02e2e',
        barb: '#7b1fa2',
        maneuver: '#ff8f00',
        maneuverStroke: '#5c3c00'
    };

    // parses #rgb / #rrggbb / rgb() / rgba() into components, or null.
    // The #rgb shorthand matters: AvNav's own defaults for fontColor and
    // fontShadowColor are "#000"/"#fff", and without it those two never
    // dimmed at night.
    function parseColor(color) {
        if (typeof color !== 'string') return null;
        var m = /^#([\da-fA-F]{2})([\da-fA-F]{2})([\da-fA-F]{2})$/.exec(color);
        if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
        var m3 = /^#([\da-fA-F])([\da-fA-F])([\da-fA-F])$/.exec(color);
        if (m3) return { r: parseInt(m3[1] + m3[1], 16), g: parseInt(m3[2] + m3[2], 16),
                         b: parseInt(m3[3] + m3[3], 16), a: 1 };
        var rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
        if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3],
                           a: rgba[4] === undefined ? 1 : +rgba[4] };
        return null;
    }

    // mixes a colour towards white - the boat marker is derived from the route
    // colour this way, so it is recognisably the same route while staying
    // brighter than the line it sits on
    function lighten(color, amount) {
        var c = parseColor(color);
        if (!c) return color;
        var mix = function (v) { return Math.round(v + (255 - v) * amount); };
        var rgb = mix(c.r) + ',' + mix(c.g) + ',' + mix(c.b);
        return c.a >= 1 ? 'rgb(' + rgb + ')' : 'rgba(' + rgb + ',' + c.a + ')';
    }

    // applies an alpha to a colour, returning rgba(). A colour that already
    // carries an alpha (someone typed rgba(...) into the layout editor) keeps
    // its own transparency: the factor multiplies it rather than replacing
    // it, otherwise night mode would leave such a colour at full brightness.
    // Anything parseColor() does not understand is returned untouched.
    function hexToRgba(color, alpha) {
        var c = parseColor(color);
        if (!c) return color;
        var combined = Math.round(c.a * alpha * 1000) / 1000;
        return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + combined + ')';
    }

    // AvNav's own night dimming (see getColor() in the viewer bundle):
    // a colour becomes translucent by nightColorDim% while nightMode is on,
    // which reads as "dimmed" against the map's own darkened tiles. Applied
    // to every colour the layer draws with, AvNav's and our own alike.
    function nightDim(color, nightMode, dimPercent) {
        if (!nightMode) return color;
        var pct = (typeof dimPercent === 'number' && !isNaN(dimPercent)) ? dimPercent : 60;
        return hexToRgba(color, pct / 100);
    }

    // builds the per-render palette: AvNav's own route/track/font colours
    // from the store (with sane fallbacks matching AvNav's own defaults),
    // dimmed for night mode the same way AvNav dims them internally; our
    // own colours (no AvNav equivalent) dimmed the same way for consistency.
    function resolveStyle(props) {
        props = props || {};
        var nightMode = !!props.nightMode;
        var dim = props.nightColorDim;
        // an explicit colour from the layout editor wins; otherwise follow
        // AvNav's own route colour (properties.routeColor, default #27413B)
        var routeColor = props.routeLineColor || props.routeColor || '#27413B';
        var fontColor = props.fontColor || '#000';
        var fontShadowColor = props.fontShadowColor || '#fff';
        var fontShadowWidth = (typeof props.fontShadowWidth === 'number' && !isNaN(props.fontShadowWidth))
            ? props.fontShadowWidth : 3;
        // AvNav's own "Widget Base Font(px)" setting (default 14) - canvas
        // text can't see --avnav-font-family/-size, but this store property
        // is the closest native equivalent, so our labels resize with it
        // the way an HTML widget's font would.
        var widgetFontSize = (typeof props.widgetFontSize === 'number' && !isNaN(props.widgetFontSize) && props.widgetFontSize > 0)
            ? props.widgetFontSize : 14;
        return {
            route: nightDim(routeColor, nightMode, dim),
            waypoint: nightDim(routeColor, nightMode, dim),
            // start/end have no AvNav equivalent either - dim them the same
            // way as barbs/maneuver so nothing on the chart stays
            // full-brightness once night mode is on.
            start: nightDim(STATIC_STYLE.start, nightMode, dim),
            end: nightDim(STATIC_STYLE.end, nightMode, dim),
            // the hull takes its fill from the route colour, mixed well
            // towards white so the marker separates from the line it sits on
            // instead of disappearing into it; the outline is black, like
            // AvNav outlines its own symbols.
            boat: nightDim(lighten(routeColor, 0.62), nightMode, dim),
            boatBorder: nightDim('#000000', nightMode, dim),
            label: nightDim(fontColor, nightMode, dim),
            labelHalo: nightDim(fontShadowColor, nightMode, dim),
            labelHaloWidth: fontShadowWidth,
            textScale: widgetFontSize / 14,
            barb: nightDim(STATIC_STYLE.barb, nightMode, dim),
            maneuver: nightDim(STATIC_STYLE.maneuver, nightMode, dim),
            maneuverStroke: nightDim(STATIC_STYLE.maneuverStroke, nightMode, dim)
        };
    }

    var MARKER_MIN_PX = 14;
    var LABEL_MIN_PX = 70;
    var BARB_MIN_PX = 55;
    var MANEUVER_LABEL_MIN_PX = 46;

    function drawDot(ctx, p, radius, color) {
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(p[0], p[1], radius, 0, 2 * Math.PI);
        ctx.fill();
    }

    // shared text-with-halo drawing, offset dy (device px) below p, rotated
    // to stay upright per textRotation(). drawLabel (time labels) and the
    // maneuver name label both go through this - only the offset, color and
    // baseline differ.
    function drawText(ctx, style, p, dy, text, mapRotation, preRotated, scale, opts) {
        opts = opts || {};
        var rot = textRotation(mapRotation, preRotated);
        ctx.save();
        ctx.translate(p[0], p[1] + dy);
        if (rot) ctx.rotate(rot);
        var textScale = (typeof style.textScale === 'number' && !isNaN(style.textScale)) ? style.textScale : 1;
        ctx.font = (opts.bold ? 'bold ' : '') + ((opts.fontSize || 11) * scale * textScale) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = opts.baseline || 'bottom';
        ctx.lineWidth = style.labelHaloWidth * scale;
        ctx.strokeStyle = style.labelHalo;
        ctx.strokeText(text, 0, 0);
        ctx.fillStyle = opts.color || style.label;
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    function drawLabel(ctx, style, p, text, mapRotation, preRotated, scale) {
        drawText(ctx, style, p, -10 * scale, text, mapRotation, preRotated, scale, {});
    }

    function strokeOrFillShape(ctx, shape) {
        if (shape.type === 'circle') {
            ctx.beginPath();
            ctx.arc(shape.cx, shape.cy, shape.r, 0, 2 * Math.PI);
            ctx.stroke();
        } else if (shape.type === 'line') {
            ctx.beginPath();
            ctx.moveTo(shape.points[0][0], shape.points[0][1]);
            ctx.lineTo(shape.points[1][0], shape.points[1][1]);
            ctx.stroke();
        } else if (shape.type === 'poly') {
            ctx.beginPath();
            ctx.moveTo(shape.points[0][0], shape.points[0][1]);
            for (var i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i][0], shape.points[i][1]);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    }

    // draws a wind barb at p, shaft pointing in the true direction the wind
    // comes from (twdDeg). Halo pass first (like drawLabel), then the
    // colored shapes on top, so barbs stay legible over any chart.
    function drawBarb(ctx, style, context, p, twdDeg, speedKn, mapRotation, preRotated, scale) {
        var feathers = barbFeathers(speedKn);
        var geo = barbGeometry(feathers, { scale: scale });
        var angle = shapeRotation((twdDeg || 0) * Math.PI / 180, mapRotation, preRotated);
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.rotate(angle);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = style.labelHalo;
        ctx.fillStyle = style.labelHalo;
        ctx.lineWidth = 3.5 * scale;
        geo.shapes.forEach(function (s) { strokeOrFillShape(ctx, s); });
        ctx.strokeStyle = style.barb;
        ctx.fillStyle = style.barb;
        ctx.lineWidth = 1.6 * scale;
        geo.shapes.forEach(function (s) { strokeOrFillShape(ctx, s); });
        ctx.restore();
    }

    // A boat hull seen from above: pointed stem, full midships, square
    // transom. Deliberately not AvNav's AIS triangle - the reference route's
    // boat should not be mistaken for a real AIS target - and no course
    // vector, which only duplicated the route line it lay along.
    var BOAT = {
        halfLength: 8,      // device px at scale 1
        halfBeam: 5.2
    };

    function drawBoat(ctx, style, context, p, cogDeg, mapRotation, preRotated, scale) {
        var angle = shapeRotation((cogDeg || 0) * Math.PI / 180, mapRotation, preRotated);
        var L = BOAT.halfLength * scale;
        var W = BOAT.halfBeam * scale;
        var hull = function () {
            ctx.beginPath();
            ctx.moveTo(0, -1.6 * L);                                              // stem head
            ctx.bezierCurveTo(0.75 * W, -1.05 * L, W, -0.25 * L, W, 0.45 * L);    // starboard bow to quarter
            ctx.lineTo(0.88 * W, 1.05 * L);                                       // starboard transom corner
            ctx.lineTo(-0.88 * W, 1.05 * L);                                      // transom
            ctx.lineTo(-W, 0.45 * L);
            ctx.bezierCurveTo(-W, -0.25 * L, -0.75 * W, -1.05 * L, 0, -1.6 * L);  // port side back to the stem
            ctx.closePath();
        };
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.rotate(angle);
        ctx.lineJoin = 'round';
        // a halo first, the same trick the labels and barbs use, so the hull
        // keeps its edges over the route line or a busy chart
        hull();
        ctx.strokeStyle = style.labelHalo;
        ctx.lineWidth = 4 * scale;
        ctx.stroke();
        hull();
        ctx.fillStyle = style.boat;
        ctx.fill();
        ctx.lineWidth = 1.4 * scale;
        ctx.strokeStyle = style.boatBorder;
        ctx.stroke();
        ctx.restore();
    }

    // small diamond glyph marking a maneuver waypoint - deliberately not a
    // dot (so it doesn't read as "just another waypoint marker") and drawn
    // with its own halo so it survives sitting on the route line or a barb.
    function drawManeuverGlyph(ctx, style, p, scale) {
        var r = 5.5 * scale;
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = style.labelHalo;
        ctx.stroke();
        ctx.fillStyle = style.maneuver;
        ctx.lineWidth = 1.3 * scale;
        ctx.strokeStyle = style.maneuverStroke;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // maneuver glyphs are drawn at every maneuver point (there are only a
    // handful on a whole route); the name label is decluttered separately
    // since a beat has several tacks close together on the chart.
    function drawManeuverMarkers(ctx, style, px, points, mapRotation, preRotated, scale) {
        var idxs = [];
        for (var i = 0; i < points.length; i++) {
            if (points[i] && points[i].maneuver) idxs.push(i);
        }
        if (!idxs.length) return;
        var manPx = idxs.map(function (i) { return px[i]; });
        var labelPositions = declutter(manPx, MANEUVER_LABEL_MIN_PX * scale);
        var showLabel = {};
        labelPositions.forEach(function (pos) { showLabel[idxs[pos]] = true; });
        idxs.forEach(function (i) {
            drawManeuverGlyph(ctx, style, px[i], scale);
            if (showLabel[i]) {
                drawText(ctx, style, px[i], 15 * scale, points[i].maneuver, mapRotation, preRotated, scale,
                    { color: style.maneuverStroke, fontSize: 10, bold: true, baseline: 'top' });
            }
        });
    }

    // draws each contiguous run of points flagged with flagKey. A
    // single-point run has no segment to draw, so it gets drawSingle instead.
    function drawFlagRuns(points, flagKey, drawRun, drawSingle) {
        flagRuns(points, flagKey).forEach(function (run) {
            if (run.end > run.start) drawRun(run);
            else drawSingle(run.start);
        });
    }

    // true if the segment from point i to i+1 is motored - i.e. both of its
    // ends are flagged. Matches the runs drawn by drawEngineSegments().
    function isEngineSegment(points, i) {
        return !!(points[i] && points[i].engine && points[i + 1] && points[i + 1].engine);
    }

    // strokes the polyline through px, skipping every segment for which
    // skip(i) is true, so the skipped stretches stay empty for another pass.
    function strokePolyline(ctx, px, color, width, skip) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        var open = false;
        for (var i = 0; i + 1 < px.length; i++) {
            if (skip && skip(i)) { open = false; continue; }
            if (!open) { ctx.moveTo(px[i][0], px[i][1]); open = true; }
            ctx.lineTo(px[i + 1][0], px[i + 1][1]);
        }
        ctx.stroke();
    }

    // engine stretches are drawn as short dashes in place of the route line
    // (drawRoute leaves those segments out) - in the route's own colour, so
    // the route reads as one line that is simply dashed where the engine
    // runs, with no second colour mixed into it.
    function drawEngineSegments(ctx, style, px, points, scale) {
        drawFlagRuns(points, 'engine', function (run) {
            ctx.save();
            ctx.setLineDash([5 * scale, 4 * scale]);
            ctx.beginPath();
            ctx.strokeStyle = style.route;
            ctx.lineWidth = 3 * scale;
            ctx.moveTo(px[run.start][0], px[run.start][1]);
            for (var j = run.start + 1; j <= run.end; j++) ctx.lineTo(px[j][0], px[j][1]);
            ctx.stroke();
            ctx.restore();
        }, function (i) {
            drawDot(ctx, px[i], 4 * scale, style.route);
        });
    }

    function drawRoute(context, props) {
        // stashed for inspection from the page (window.avnavWeatherRoute) -
        // not used by drawing itself.
        state.lastRenderProps = props;
        if (state.hidden) return;
        var route = state.route;
        if (!route || !route.points || route.points.length < 1) return;
        var ctx = context.getContext();
        if (!ctx) return;
        var points = route.points;
        var mapRotation = (context.getRotation && context.getRotation()) || 0;
        var preRotated = isPreRotated();
        // lonLatToPixel returns device pixels - scale every size with the
        // device pixel ratio so the drawing keeps its size on hidpi displays
        var scale = (context.getScale && context.getScale()) || 1;
        var px = points.map(function (p) { return context.lonLatToPixel(p.lon, p.lat); });
        var time = getDisplayTime(props);
        var interp = points.length > 1 ? interpolate(route, time) : null;
        var showMetadata = props.showMetadata !== false;
        var style = resolveStyle(props);
        state.lastStyle = style;

        ctx.save();
        // the whole route in one colour - which part is already behind the
        // boat is obvious from the boat marker and the waypoint times.
        // Motored stretches are left out here and drawn dashed below.
        var drawEngine = showMetadata && points.length > 1;
        if (points.length > 1) {
            strokePolyline(ctx, px, style.route, 3 * scale, drawEngine
                ? function (i) { return isEngineSegment(points, i); }
                : null);
        }
        if (drawEngine) drawEngineSegments(ctx, style, px, points, scale);

        var markerIdx = declutter(px, MARKER_MIN_PX * scale);
        markerIdx.forEach(function (i) { drawDot(ctx, px[i], 3 * scale, style.waypoint); });

        if (props.showBarbs !== false) {
            var barbSpacing = (typeof props.barbSpacing === 'number' && !isNaN(props.barbSpacing) && props.barbSpacing > 0)
                ? props.barbSpacing : BARB_MIN_PX;
            var barbIdx = declutter(px, barbSpacing * scale);
            barbIdx.forEach(function (i) {
                var pt = points[i];
                if (pt.tws == null || pt.twd == null) return;
                drawBarb(ctx, style, context, px[i], pt.twd, pt.tws, mapRotation, preRotated, scale);
            });
        }

        var labelIdx = declutter(px, LABEL_MIN_PX * scale);
        var lastDay = null;
        labelIdx.forEach(function (i) {
            var t = points[i].t;
            if (t == null) return;
            var key = dayKey(t);
            var text = formatClock(t);
            if (lastDay !== null && key !== lastDay) text = formatDateShort(t) + ' ' + text;
            lastDay = key;
            drawLabel(ctx, style, px[i], text, mapRotation, preRotated, scale);
        });

        if (showMetadata) drawManeuverMarkers(ctx, style, px, points, mapRotation, preRotated, scale);

        drawDot(ctx, px[0], 6 * scale, style.start);
        drawDot(ctx, px[px.length - 1], 6 * scale, style.end);

        if (interp) {
            var boatPx = context.lonLatToPixel(interp.lon, interp.lat);
            drawBoat(ctx, style, context, boatPx, interp.cog, mapRotation, preRotated, scale);
        }
        ctx.restore();
    }

    // -----------------------------------------------------------------
    // route loading (user files)
    //
    // The file list from /api/user/list carries each file's modification
    // time and size, so the layer polls it every POLL_INTERVAL_MS and only
    // downloads the GPX again when the entry actually changed. A route that
    // is recalculated and uploaded under the same name therefore shows up
    // within a few seconds, without a page reload.
    // -----------------------------------------------------------------

    var POLL_INTERVAL_MS = 10000;

    function log(msg) {
        if (typeof avnav !== 'undefined' && avnav && avnav.api && avnav.api.log) avnav.api.log(msg);
    }

    // true for a name that is meant as a wildcard pattern rather than a
    // literal file name.
    function isPattern(name) {
        return /[*?]/.test(name);
    }

    // shell-style wildcards over a file name: * for any run of characters
    // (including none), ? for exactly one. Everything else is matched
    // literally, so a dot is a dot and not "any character". Matching is
    // case sensitive, like the exact-name case.
    function patternToRegExp(pattern) {
        var rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[\\s\\S]*')
            .replace(/\?/g, '[\\s\\S]');
        return new RegExp('^' + rx + '$');
    }

    // the most recently changed of a list of entries. AvNav reports each
    // file's mtime as `time`; an entry without one counts as oldest.
    function newestItem(items) {
        return items.reduce(function (best, it) {
            if (!best) return it;
            return (it.time || 0) > (best.time || 0) ? it : best;
        }, null) || null;
    }

    // the list entry to load. An exact name is taken exactly - never a
    // substitute. A name with wildcards, or no name at all, selects the
    // newest .gpx among the matches, so a fresh upload takes over by
    // itself. AvNav lists the directory in filesystem order, which is
    // neither newest-first nor alphabetical, so the choice must be made
    // here rather than by taking the first entry.
    function findRouteItem(items, wanted) {
        var gpxItems = (items || []).filter(function (it) {
            return it && typeof it.name === 'string' && /\.gpx$/i.test(it.name);
        });
        if (!wanted) return newestItem(gpxItems);
        if (isPattern(wanted)) {
            var rx = patternToRegExp(wanted);
            return newestItem(gpxItems.filter(function (it) { return rx.test(it.name); }));
        }
        return gpxItems.filter(function (it) { return it.name === wanted; })[0] || null;
    }

    function itemChanged(item) {
        return !state.route || item.name !== state.loadedFile ||
            item.time !== state.loadedTime || item.size !== state.loadedSize;
    }

    function setLoadError(msg) {
        if (msg && msg !== state.loadError) log('WR: ' + msg);
        state.loadError = msg;
    }

    // installs a freshly parsed route. A scrub position survives a reload by
    // time, not by index - after a recalculation the waypoint count changes
    // but "the waypoint around 15:30" is still what the user was looking at.
    function applyRoute(route, item) {
        state.route = route;
        state.loadedFile = item.name;
        state.loadedTime = item.time;
        state.loadedSize = item.size;
        var pts = route.points;
        if (state.mode === 'scrub' && pts.length) {
            var idx = typeof state.scrubTime === 'number' ? nearestIndex(route, state.scrubTime) : state.selectedIndex;
            idx = clampIndex(idx, pts.length);
            state.selectedIndex = idx;
            state.scrubTime = pts[idx].t;
        }
        log('WR: loaded ' + item.name + ' (' + pts.length + ' points)');
    }

    // one check of the user file list; downloads the GPX when it is new or
    // changed (or always with force, after the routeFile parameter changed).
    function checkRouteFile(force) {
        if (state.loading) return;
        var wanted = state.routeFile || '';
        state.loading = true;
        var gen = ++loadGeneration;
        fetch('/api/user/list').then(function (resp) {
            return resp.json();
        }).then(function (data) {
            if (gen !== loadGeneration) return;
            var chosen = findRouteItem(data && data.items, wanted);
            if (!chosen) {
                state.loading = false;
                setLoadError(wanted
                    ? (isPattern(wanted)
                        ? 'no .gpx user file matches "' + wanted + '"'
                        : 'route file "' + wanted + '" not found in user files')
                    : 'no .gpx user file found');
                // the file is gone - do not keep showing a route that no
                // longer exists
                if (state.route) {
                    state.route = null;
                    state.loadedFile = null;
                    state.loadedTime = null;
                    state.loadedSize = null;
                    notify();
                }
                return;
            }
            if (!force && !itemChanged(chosen)) {
                state.loading = false;
                return;
            }
            return fetch(chosen.url).then(function (r2) { return r2.text(); }).then(function (text) {
                if (gen !== loadGeneration) return;
                applyRoute(parseGpx(text), chosen);
                state.loading = false;
                setLoadError(null);
                notify();
            });
        }).catch(function (err) {
            if (gen !== loadGeneration) return;
            state.loading = false;
            setLoadError('failed to load route: ' + err);
            notify();
        });
    }

    // called on every render: starts a (re)load only when the routeFile
    // parameter changed; everything else is left to the poll timer.
    function ensureRouteLoaded(props) {
        var wanted = (props && props.routeFile) || '';
        if (wanted === state.routeFile) return;
        state.routeFile = wanted;
        state.route = null;
        state.loadedFile = null;
        state.loadedTime = null;
        state.loadedSize = null;
        state.loadError = null;
        state.loading = false;
        loadGeneration++;   // abandons any load still in flight for the old name
        checkRouteFile(true);
    }

    // -----------------------------------------------------------------
    // timers: a 1 s redraw tick keeps the boat moving without map
    // interaction, a 10 s poll picks up a new or changed route file.
    // -----------------------------------------------------------------

    var timerHandle = null;
    var pollHandle = null;
    function startTimer() {
        if (!timerHandle) {
            timerHandle = setInterval(function () {
                if (state.mode === 'live') notify();
            }, 1000);
        }
        if (!pollHandle) {
            pollHandle = setInterval(function () {
                if (state.routeFile !== null) checkRouteFile(false);
            }, POLL_INTERVAL_MS);
        }
    }

    function stopTimer() {
        if (timerHandle) {
            clearInterval(timerHandle);
            timerHandle = null;
        }
        if (pollHandle) {
            clearInterval(pollHandle);
            pollHandle = null;
        }
    }

    // -----------------------------------------------------------------
    // widget registration
    // -----------------------------------------------------------------

    var routeLayerWidget = {
        name: 'WRRouteLayer',
        type: 'map',
        // nightMode itself arrives as a reserved, automatically-injected
        // prop - only the AvNav colour/dimming properties it pairs with
        // need an explicit storeKey.
        storeKeys: {
            rtime: 'nav.gps.rtime',
            routeColor: 'properties.routeColor',
            fontColor: 'properties.fontColor',
            fontShadowColor: 'properties.fontShadowColor',
            fontShadowWidth: 'properties.fontShadowWidth',
            nightColorDim: 'properties.nightColorDim',
            widgetFontSize: 'properties.widgetFontSize'
        },
        initFunction: function (context, props) {
            registerContext(context);
            ensureRouteLoaded(props);
            startTimer();
        },
        finalizeFunction: function (context) {
            unregisterContext(context);
        },
        renderCanvas: function (canvas, props, context) {
            ensureRouteLoaded(props);
            drawRoute(context, props);
        }
    };

    var routeLayerParameters = {
        routeFile: {
            type: 'STRING',
            default: '',
            description: 'route GPX file name (from user files); empty = first .gpx found. Checked every 10 s for changes'
        },
        showBarbs: {
            type: 'BOOLEAN',
            default: true,
            description: 'draw wind barbs (true wind at the boat) along the route'
        },
        routeLineColor: {
            type: 'COLOR',
            // a green in AvNav's own palette range (hue 120, saturation and
            // lightness matching its bearing/track/nav colours) - AvNav's
            // route colour itself is nearly black on a chart. Clear the field
            // to follow AvNav's properties.routeColor instead.
            default: '#27BE27',
            description: "colour of the route line; clear it to follow AvNav's own route colour"
        },
        barbSpacing: {
            type: 'NUMBER',
            default: 55,
            description: 'minimum pixel spacing between drawn wind barbs'
        },
        showMetadata: {
            type: 'BOOLEAN',
            default: true,
            description: 'draw maneuver markers and engine segments'
        }
    };

    // -----------------------------------------------------------------
    // WRRouteControl - the scrub control (a normal HTML widget)
    // -----------------------------------------------------------------

    function formatWaypointLabel(index, total) {
        return 'WP ' + (index + 1) + '/' + total;
    }

    var routeControlWidget = {
        name: 'WRRouteControl',
        storeKeys: {
            rtime: 'nav.gps.rtime'
        },
        initFunction: function (context, props) {
            registerContext(context);
            context.lastProps = props;
            context.eventHandler.wrStepBack = function () {
                scrubStep(-1, this.lastProps || {});
            };
            context.eventHandler.wrStepFwd = function () {
                scrubStep(1, this.lastProps || {});
            };
            context.eventHandler.wrGoLive = function () {
                liveButton();
            };
        },
        finalizeFunction: function (context) {
            unregisterContext(context);
        },
        renderHtml: function (props, context) {
            // stashed so the click handlers (which only get the event, not
            // props) can read the current live time when adopting it
            context.lastProps = props;
            var route = state.route;
            var pts = route && route.points;
            var total = pts ? pts.length : 0;
            var hidden = !!state.hidden;
            var isLive = state.mode !== 'scrub';
            var idx = isLive ? -1 : state.selectedIndex;
            var timeText, wpText;
            if (hidden) {
                timeText = '--:--';
                wpText = 'OFF';
            } else if (isLive) {
                timeText = total ? formatClock(getDisplayTime(props)) : '--:--';
                wpText = 'LIVE';
            } else {
                var pt = pts && pts[idx];
                timeText = (pt && pt.t != null) ? formatClock(pt.t) : '--:--';
                wpText = formatWaypointLabel(idx, total);
            }
            var replacements = {
                time: timeText,
                wpText: wpText,
                offClass: hidden ? ' wrOff' : '',
                liveClass: (!hidden && isLive) ? ' wrActive' : '',
                // while off, every button must stay pressable: each of them
                // switches the display back on
                prevDisabled: (!hidden && !isLive && idx <= 0) ? 'disabled' : '',
                nextDisabled: (!hidden && !isLive && total && idx >= total - 1) ? 'disabled' : ''
            };
            // two rows: the info text spans the full widget width (needed -
            // the host's default 3em widgetData font size leaves little
            // room, and a narrow flex column between two buttons overflows
            // sideways into them), buttons go in their own row below.
            var template = '<div class="widgetData wrControl${offClass}">' +
                '<div class="wrControlInfo">' +
                '<span class="wrControlTime">${time}</span>' +
                '<span class="wrControlWp">${wpText}</span>' +
                '</div>' +
                '<div class="wrControlRow">' +
                '<button class="wrBtn" onclick="wrStepBack" ${prevDisabled}>&#9664;</button>' +
                '<button class="wrLiveBtn${liveClass}" onclick="wrGoLive">LIVE</button>' +
                '<button class="wrBtn" onclick="wrStepFwd" ${nextDisabled}>&#9654;</button>' +
                '</div>' +
                '</div>';
            return avnav.api.templateReplace(template, replacements);
        }
    };

    // -----------------------------------------------------------------
    // WRRoutePoint - compact metadata readout for the current waypoint
    // (the scrubbed one in scrub mode, the nearest one to the boat in
    // live mode). Small on purpose: see routePointRows() for the pure
    // field logic and plugin.css for the three-column grid layout.
    // -----------------------------------------------------------------

    var routePointWidget = {
        name: 'WRRoutePoint',
        storeKeys: {
            rtime: 'nav.gps.rtime'
        },
        initFunction: function (context, props) {
            registerContext(context);
        },
        finalizeFunction: function (context) {
            unregisterContext(context);
        },
        renderHtml: function (props, context) {
            // the route display is switched off from the control - showing
            // waypoint values for a route that is not on the chart would be
            // a half-off state, so this widget goes quiet with it
            if (state.hidden) {
                return '<div class="widgetData wrpWidget wrpEmpty">weather route off</div>';
            }
            var route = state.route;
            var pts = route && route.points;
            var total = pts ? pts.length : 0;
            if (!total) {
                return '<div class="widgetData wrpWidget wrpEmpty">no route</div>';
            }
            var idx = state.mode === 'scrub' ? state.selectedIndex : nearestIndex(route, getLiveTime(props));
            idx = clampIndex(idx, total);
            var detail = routePointRows(pts[idx], route.units, idx, total, props, route.settings, route.available);
            // one grid row per line: label, number, unit
            var cells = detail.fields.map(function (f) {
                return '<span class="wrpLbl">' + avnav.api.escapeHtml(f.label) + '</span>' +
                    '<span class="wrpNum">' + avnav.api.escapeHtml(f.num) + '</span>' +
                    // the degree sign belongs tight against its number, unlike
                    // a word unit ("15.0 kn"), so it gets pulled back over the gap
                    '<span class="wrpUnit' + (f.unit === '\u00b0' ? ' wrpDeg' : '') + '">' +
                    avnav.api.escapeHtml(f.unit) + '</span>';
            }).join('');
            var flagsHtml = '';
            if (detail.flags.length) {
                flagsHtml = '<div class="wrpFlags">' + detail.flags.map(function (f) {
                    return '<span class="wrpFlag">' + avnav.api.escapeHtml(f) + '</span>';
                }).join('') + '</div>';
            }
            return '<div class="widgetData wrpWidget">' +
                '<div class="wrpGrid">' + cells + '</div>' +
                flagsHtml +
                '</div>';
        }
    };

    // One switch per line, listed in exactly the order the lines appear.
    // WP and Time default to off: the scrub control shows both. The ground
    // and apparent wind, the courses and the motor settings are off too, so
    // they do not change a layout that is already set up.
    var routePointParameters = {
        showWp: { type: 'BOOLEAN', default: false, description: 'show the waypoint number' },
        showTime: { type: 'BOOLEAN', default: false, description: 'show the time at the waypoint' },

        showGws: { type: 'BOOLEAN', default: false, description: 'ground wind: speed (equals TWS without current)' },
        showGwd: { type: 'BOOLEAN', default: false, description: 'ground wind: direction (equals TWD without current)' },

        showTws: { type: 'BOOLEAN', default: true, description: 'true wind: speed' },
        showGust: { type: 'BOOLEAN', default: true, description: 'true wind: gust speed' },
        showTwd: { type: 'BOOLEAN', default: true, description: 'true wind: direction' },
        showTwa: { type: 'BOOLEAN', default: true, description: 'true wind: angle to the boat' },

        showAws: { type: 'BOOLEAN', default: false, description: 'apparent wind: speed' },
        showAwa: { type: 'BOOLEAN', default: false, description: 'apparent wind: angle' },

        showStw: { type: 'BOOLEAN', default: true, description: 'boat: speed through water' },
        showCtw: { type: 'BOOLEAN', default: false, description: 'boat: course through water' },
        showSog: { type: 'BOOLEAN', default: true, description: 'boat: speed over ground' },
        showCog: { type: 'BOOLEAN', default: false, description: 'boat: course over ground (equals CTW without current)' },

        showSwh: { type: 'BOOLEAN', default: true, description: 'waves: significant height' },
        showPeriod: { type: 'BOOLEAN', default: true, description: 'waves: period' },
        showWaveDir: { type: 'BOOLEAN', default: true, description: 'waves: direction' },

        showCurSpeed: { type: 'BOOLEAN', default: false, description: 'current: speed (drift)' },
        showCurSet: { type: 'BOOLEAN', default: false, description: 'current: the direction it sets towards' },

        showMotorSpeed: { type: 'BOOLEAN', default: false, description: 'route setting: the speed the router assumes under engine' },
        showMotorBelowTws: { type: 'BOOLEAN', default: false, description: 'route setting: motor when the true wind is below this speed' },

        showFlags: { type: 'BOOLEAN', default: true, description: 'the maneuver / night / engine markers' }
    };

    if (typeof avnav !== 'undefined' && avnav && avnav.api) {
        avnav.api.registerWidget(routeLayerWidget, routeLayerParameters);
        avnav.api.registerWidget(routeControlWidget);
        avnav.api.registerWidget(routePointWidget, routePointParameters);
        avnav.api.log('WR: widgets registered');
    }

    // -----------------------------------------------------------------
    // public surface: exposed on the page as window.avnavWeatherRoute for
    // inspection, and as a CommonJS export when loaded outside a browser.
    // -----------------------------------------------------------------

    var WR = {
        state: state,
        parseGpx: parseGpx,
        parseColor: parseColor,
        lighten: lighten,
        interpolate: interpolate,
        bearing: bearing,
        legHeading: legHeading,
        normalizeAngle: normalizeAngle,
        declutter: declutter,
        barbFeathers: barbFeathers,
        drawBarb: drawBarb,
        drawBoat: drawBoat,
        BOAT_GEOMETRY: BOAT,
        barbGeometry: barbGeometry,
        formatClock: formatClock,
        formatDateShort: formatDateShort,
        dayKey: dayKey,
        isPreRotatedVersion: isPreRotatedVersion,
        shapeRotation: shapeRotation,
        textRotation: textRotation,
        getDisplayTime: getDisplayTime,
        getLiveTime: getLiveTime,
        stepIndex: stepIndex,
        nearestIndex: nearestIndex,
        selectWaypoint: selectWaypoint,
        scrubStep: scrubStep,
        goLive: goLive,
        liveButton: liveButton,
        formatWaypointLabel: formatWaypointLabel,
        routePointRows: routePointRows,
        routePointParameters: routePointParameters,
        routeLayerParameters: routeLayerParameters,
        splitValue: splitValue,
        speedUnitSuffix: speedUnitSuffix,
        rawUnitSuffix: rawUnitSuffix,
        flagRuns: flagRuns,
        hexToRgba: hexToRgba,
        nightDim: nightDim,
        resolveStyle: resolveStyle,
        notify: notify,
        ensureRouteLoaded: ensureRouteLoaded,
        checkRouteFile: checkRouteFile,
        findRouteItem: findRouteItem,
        isPattern: isPattern,
        patternToRegExp: patternToRegExp,
        newestItem: newestItem,
        registerContext: registerContext,
        unregisterContext: unregisterContext
    };

    if (typeof window !== 'undefined') window.avnavWeatherRoute = WR;
    if (typeof module !== 'undefined' && module.exports) module.exports = WR;
}());
