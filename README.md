# AvNav Weather Routing Plugin

Shows a weather-routing result (a GPX file produced by SailRouter, or any
compatible weather-routing tool) on the AvNav chart: the routed track, wind
barbs, waypoint times, tacks/gybes, engine and night stretches, and a boat
marker - drawn like an AvNav AIS target, in a colour derived from the
route - that moves along the route with time - either live (following the
clock) or scrubbed by hand, one waypoint at a time.

The plugin never touches AvNav's own active route. It only draws its own,
separate "reference route" layer on top of the chart.

![Weather route on the chart, with wind barbs, a tack marker and the two
detail widgets](test/shots/detail_chart_maneuver.png)

## Installation

The plugin is plain JavaScript/CSS - **no Python**, no build step, and it
runs on AvNav's current stable release (as well as the daily builds).

1. Copy (or symlink) the `plugin/` directory from this repository to
   AvNav's plugin directory, under a folder named after the plugin, e.g.:

   ```
   sudo cp -r plugin /var/lib/avnav/plugins/weatherroute
   ```

   (or, if you prefer to keep the repository as the source of truth:
   `sudo ln -s /path/to/this/repo/plugin /var/lib/avnav/plugins/weatherroute`)

2. Restart AvNav so it picks up the new plugin (only needed the first time,
   or whenever you add/remove files from the plugin directory - editing
   `plugin.js`/`plugin.css` afterwards only needs a browser reload):

   - if AvNav runs as a system service: `sudo systemctl restart avnav`
   - otherwise, stop and re-launch AvNav's own start script as you normally
     would on your system

3. Open AvNav in the browser. There is nothing else to configure at this
   point - the plugin registers itself, but it draws nothing until you (a)
   have a route GPX uploaded and (b) have added its widgets to a layout, see
   below.

## Getting a route in

The plugin reads the GPX **from AvNav's user files**, not from AvNav's own
route store (AvNav's route store strips out the timing and weather
information the file carries, so importing it as a normal route would throw
away everything this plugin needs).

1. In the main menu, open **CSS, JS, User Apps**.
2. In the **User Files** column, click **Upload file** and pick the `.gpx`
   file exported by your weather-routing tool.
3. That's it - the plugin polls AvNav's user files itself and picks up any
   `.gpx` file it finds there.

   ![CSS, JS, User Apps page, with the User Files column and its Upload file button](test/shots/user_files_upload.png)

If you keep more than one `.gpx` file in your user files, the map widget's
**routeFile** parameter (see below) lets you pick which one to show; with it
left empty, the plugin just uses the first `.gpx` file it finds.

## Adding the widgets to a layout

The plugin provides three widgets:

- **WRRouteLayer** - draws the route on the chart itself. This is a *map*
  widget, so it does not go into a normal widget panel - it goes into the
  navigation page's **overlay** panel, via the layout editor's dedicated
  "Map Widgets" button.
- **WRRouteControl** - the small scrub control (◀ / ▶ and a LIVE button).
- **WRRoutePoint** - the compact readout of the current waypoint's wind,
  waves, speed, maneuver/night/engine flags.

The latter two are normal (HTML) widgets and go into any ordinary widget
panel, e.g. the navigation page's left column.

All of this happens in AvNav's **layout editor**. The exact, verified click
path:

1. Open the main menu and choose **Layouts**.

   ![Main menu](test/shots/menu_main.png)

2. Under "Current", click the pencil/**Edit** icon next to the layout you
   want to change.

   ![Layouts page, with the Edit button next to the current layout](test/shots/menu_layouts.png)

3. AvNav switches to layout-edit mode: the map is now framed in red and the
   right-hand toolbar changes to editing buttons (**Finished**, **Undo**,
   **Config**, **On Map**, ...).

   ![Layout edit mode toolbar](test/shots/layout_edit_mode.png)

4. **For the map widget (WRRouteLayer):** click **On Map** in the toolbar.
   This opens the "Map Widgets" dialog, listing the widgets currently drawn
   on the chart. Click the **+** button to add one, choose **WRRouteLayer**
   from the widget list, then **Ok**.

   ![Map Widgets dialog](test/shots/map_widgets_dialog.png)
   ![Selecting a widget for the overlay panel](test/shots/map_widget_add.png)

5. **For the two HTML widgets (WRRouteControl / WRRoutePoint):** click
   directly on any existing widget in the panel where you want to add them
   (e.g. one of the widgets in the left column of the navigation page). This
   opens a "Select Widget" dialog for that panel/slot.

   ![Select Widget dialog for a panel slot](test/shots/select_widget_dialog.png)

6. Click the "New Widget" field's current value to open the full widget
   picker, and choose **WRRouteControl** (repeat the whole step for
   **WRRoutePoint**).

   ![Widget picker listing all registered widgets, including WRRouteControl](test/shots/widget_picker_list.png)

7. Click **Before** or **After** to *insert* the new widget next to the one
   you clicked on (this keeps the existing widget); use **Update** instead
   if you actually want to replace the widget you clicked on.

8. Click **Finished** (top of the right-hand toolbar) to save the layout.

Once saved, the map draws the route and the two widgets appear wherever you
placed them - no further AvNav restart needed.

## Editable parameters

Configured the same way as any other AvNav widget: click the widget in the
layout editor (see step 5 above) to see its parameters.

**WRRouteLayer** (the map widget):

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `routeFile` | text | *(empty)* | Name of the `.gpx` user file to show. Leave empty to use the first `.gpx` file found. |
| `showBarbs` | yes/no | on | Draw wind barbs (true wind at the boat) along the route. |
| `routeLineColor` | colour | `#27BE27` | Colour of the route line. Clear the field to follow AvNav's own route colour (`properties.routeColor`) instead - note that one is nearly black on a chart. An `rgba(...)` value works too and keeps its transparency. |
| `barbSpacing` | number | 55 | Minimum spacing, in pixels, between drawn wind barbs - increase it if the chart looks cluttered at your usual zoom level. |
| `showMetadata` | yes/no | on | Draw maneuver (tack/gybe) markers and engine-on stretches. |

**WRRouteControl** has no parameters - place it and it works.

**WRRoutePoint** (the detail readout): one switch per line, so you can keep
only what you actually want to see. The waypoint number and its time default
to off because the scrub control above already shows both.

| Parameter | Type | Default | Line |
|---|---|---|---|
| `showWp` | yes/no | **off** | `WP` - waypoint number. |
| `showTime` | yes/no | **off** | `Time` - time at that waypoint. |
| `showGws` | yes/no | **off** | `GWS` - ground wind speed. |
| `showGwd` | yes/no | **off** | `GWD` - ground wind direction. |
| `showTws` | yes/no | on | `TWS` - true wind speed. |
| `showGust` | yes/no | on | `Gust`. |
| `showTwd` | yes/no | on | `TWD` - true wind direction. |
| `showTwa` | yes/no | on | `TWA` - true wind angle. |
| `showAws` | yes/no | **off** | `AWS` - apparent wind speed. |
| `showAwa` | yes/no | **off** | `AWA` - apparent wind angle. |
| `showStw` | yes/no | on | `STW` - speed through water. |
| `showCtw` | yes/no | **off** | `CTW` - course through water. |
| `showSog` | yes/no | on | `SOG`, shown only when it differs from STW. |
| `showCog` | yes/no | **off** | `COG` - course over ground. |
| `showSwh` | yes/no | on | `SWH` - significant wave height. |
| `showPeriod` | yes/no | on | `Period` - wave period. |
| `showWaveDir` | yes/no | on | `Wave dir`. |
| `showMotorSpeed` | yes/no | **off** | `Motor` - the speed the router assumes under engine. |
| `showMotorBelowTws` | yes/no | **off** | `Motor <` - motor when the true wind is below this speed. |
| `showFlags` | yes/no | on | The `Tack` / `Night` / `Engine` markers. |

The last two come from the route's own settings in the GPX metadata rather
than from a waypoint, so they read the same at every point.

The lines marked off by default are the rest of what the GPX carries.
They are off so they do not change a layout you have already set up - switch
on whatever you want to see. Note that **ground wind differs from true wind,
and CTW from COG, only where the router worked with tidal current**: in a
route computed without current those rows simply repeat TWD/TWS and COG.

## Troubleshooting

**No route shown on the chart at all**
- Check that a `.gpx` file is actually present in AvNav's user files (main
  menu > CSS, JS, User Apps > User Files).
- Check that the **WRRouteLayer** widget is actually in the navigation
  page's overlay panel (main menu > Layouts > Edit > On Map).
- If you set `routeFile` explicitly, make sure it matches the uploaded
  file's name exactly (case-sensitive).
- Open the browser's developer console; the plugin logs `WR:` prefixed
  messages, including load errors (e.g. "no .gpx user file found").

**A widget doesn't show up at all**
- It has to be added to a layout first (see "Adding the widgets" above) -
  installing the plugin only makes the widgets *available*, it does not
  place them anywhere.
- WRRouteControl/WRRoutePoint are normal HTML widgets; WRRouteLayer is a
  *map* widget and only works in the overlay panel, not in a normal widget
  column.

**Times look wrong**
- All times the plugin shows (waypoint labels, the scrub control, the
  detail widget) are converted to your browser/device's own local time
  zone, the same way every other AvNav time widget works - they are **not**
  the raw UTC timestamps stored in the GPX. If your device's clock or time
  zone is wrong, the displayed times will be off by the same amount.
- In **live** mode the boat position follows AvNav's own GPS time when a fix
  is available, and falls back to the device's own clock when there is no
  GPS at all. Without a GPS fix (or before the route's start time), the boat
  marker simply sits at the route's first waypoint.
- Speeds are shown however AvNav's own speed formatter renders them; if
  that ever looks like a mismatched unit, it will be AvNav's own configured
  unit, not the GPX file's.
