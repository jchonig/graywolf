<script>
  import { onMount } from 'svelte';
  import { Box, Button, Input, Toggle, Radio, RadioGroup } from '@chrissnell/chonky-ui';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { toasts } from '../lib/stores.js';
  import { mapRoutesStore } from '../lib/map/map-routes-store.svelte.js';
  import { parseRouteFile, simplifyRoute } from '../lib/map/route-import.js';
  import { mapsState, ISSUES_URL } from '../lib/settings/maps-store.svelte.js';
  import { mapState } from '../lib/map/map-store.svelte.js';
  import { RADAR_REGION_US, RADAR_REGION_WORLD } from '../lib/map/sources/radar-source.js';
  import { validateCallsign } from '../lib/maps/callsign.js';
  import { downloadsState } from '../lib/maps/downloads-store.svelte.js';
  import { catalogStore } from '../lib/maps/catalog-store.svelte.js';
  import { localBoundsStore } from '../lib/maps/local-bounds-store.svelte.js';
  import { formatBytes } from '../lib/maps/format-bytes.js';
  import RegionPicker from '../lib/maps/region-picker.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import wolfLogoUrl from '../assets/graywolf.svg';

  let consented = $state(false);
  let callsignInput = $state('');
  let lastError = $state(null); // { ok, status, code, message }

  let pickerOpen = $state(false);

  let validation = $derived(validateCallsign(callsignInput));
  let canSubmit = $derived(consented && validation.ok && !mapsState.registering);

  // --- Route overlays -------------------------------------------------
  // A short palette assigned to new routes by upload order so distinct
  // routes get distinct lines without asking the operator to pick.
  // Chosen to sit in the hue gaps between the Americana basemap's road
  // colors (red ~0deg for motorway/trunk, gold ~48deg for primary..minor)
  // and the APRS trail palette's 7 hues (trails.js) -- every entry here is
  // >=25deg from the nearest road or trail hue, versus the old palette
  // which mirrored the trail hues almost exactly.
  const ROUTE_PALETTE = ['#7ca824', '#209760', '#4747d1', '#b937be'];
  let routeUploading = $state(false);
  let routeFileInput = $state(null); // bound <input type="file">
  let routeDeleteTarget = $state(null); // { id, name } | null
  let routeDeleteOpen = $state(false);

  function nextRouteColor() {
    return ROUTE_PALETTE[mapRoutesStore.routes.length % ROUTE_PALETTE.length];
  }

  async function onRouteFileChange(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = ''; // allow re-selecting the same file later
    if (!file) return;
    routeUploading = true;
    try {
      const text = await file.text();
      const { name, geojson } = parseRouteFile(file.name, text);
      const simplified = simplifyRoute(geojson);
      await mapRoutesStore.add({ name, color: nextRouteColor(), geojson: simplified });
      toasts.success(`Added route "${name}"`);
    } catch (err) {
      toasts.error(`Could not import route: ${err.message}`);
    } finally {
      routeUploading = false;
    }
  }

  async function commitRouteName(route, value) {
    const name = (value || '').trim();
    if (!name || name === route.name) return;
    try {
      await mapRoutesStore.update(route.id, { name });
    } catch (err) {
      toasts.error(`Could not rename route: ${err.message}`);
    }
  }

  async function commitRouteColor(route, value) {
    if (!value || value === route.color) return;
    try {
      await mapRoutesStore.update(route.id, { color: value });
    } catch (err) {
      toasts.error(`Could not recolor route: ${err.message}`);
    }
  }

  function askDeleteRoute(route) {
    routeDeleteTarget = { id: route.id, name: route.name };
    routeDeleteOpen = true;
  }

  async function confirmDeleteRoute() {
    const target = routeDeleteTarget;
    if (!target) return;
    try {
      await mapRoutesStore.remove(target.id);
      toasts.success(`Deleted route "${target.name}"`);
    } catch (err) {
      toasts.error(`Could not delete route: ${err.message}`);
    } finally {
      routeDeleteTarget = null;
    }
  }

  onMount(() => {
    mapsState.fetchConfig();
    catalogStore.load();
    localBoundsStore.load();
    mapRoutesStore.load().catch((err) => toasts.error(`Could not load routes: ${err.message}`));
    downloadsState.refresh().then(() => {
      if (
        [...downloadsState.items.values()].some(
          (d) => d.state === 'downloading' || d.state === 'pending',
        )
      ) {
        downloadsState.ensurePolling();
      }
    });
  });

  // Catalog-backed name lookup for downloaded slugs. Keys are
  // namespaced (state/<x>, country/<iso2>, province/<iso2>/<x>).
  let slugToName = $derived.by(() => {
    const cat = catalogStore.catalog;
    if (!cat) return {};
    const m = {};
    for (const c of cat.countries) m[`country/${c.iso2}`] = c.name;
    for (const p of cat.provinces) m[`province/${p.iso2}/${p.slug}`] = p.name;
    for (const s of cat.states) m[`state/${s.slug}`] = s.name;
    return m;
  });

  let downloadedRows = $derived.by(() => {
    const rows = [];
    for (const [slug, item] of downloadsState.items) {
      if (item.state === 'complete') {
        rows.push({ slug, name: slugToName[slug] ?? slug, ...item });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  });

  let activeDownloads = $derived.by(() => {
    const rows = [];
    for (const [slug, item] of downloadsState.items) {
      if (item.state === 'downloading' || item.state === 'pending' || item.state === 'error') {
        rows.push({ slug, name: slugToName[slug] ?? slug, ...item });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  });

  async function onRegister() {
    lastError = null;
    const result = await mapsState.register(callsignInput);
    if (!result.ok) {
      lastError = result;
    } else {
      callsignInput = '';
    }
  }

  async function onReregister() {
    lastError = null;
    const result = await mapsState.register(mapsState.callsign);
    if (!result.ok) {
      lastError = result;
    }
  }

  // Two radio options. Offline tiles are preferred automatically when
  // downloads exist; the Graywolf row picks them up transparently and
  // falls back to online elsewhere.
  const sources = [
    {
      value: 'graywolf',
      label: 'Graywolf private maps',
      sublabel: 'Polished cartography. Requires registration.',
    },
    {
      value: 'osm',
      label: 'OpenStreetMap public tiles',
      sublabel: 'Free, available everywhere, less polished cartography.',
    },
  ];

  function isDisabled(src) {
    if (src.value === 'graywolf' && !mapsState.registered) return true;
    return false;
  }

  function onSourceChange(v) {
    mapsState.setSource(v);
  }

  // Radar coverage region. Per-browser preference (mapState persists it to
  // localStorage); the live map's radar layer reflects the choice immediately.
  const radarRegions = [
    {
      value: RADAR_REGION_US,
      label: 'United States (NEXRAD)',
      sublabel: 'High-resolution NEXRAD reflectivity contours.',
    },
    {
      value: RADAR_REGION_WORLD,
      label: 'Rest of world (RainViewer)',
      sublabel: 'Global RainViewer composite for coverage outside the US.',
    },
  ];

  function onRadarRegionChange(v) {
    mapState.radarRegion = v;
  }
</script>

<PageHeader title="Maps" subtitle="Choose your basemap source" />

{#if !mapsState.registered}
  <Box title="About Graywolf private maps">
    <p class="prose">
      Graywolf can use a private basemap hosted by the project author,
      <strong>Chris Snell (NW5W)</strong>. Chris pays for the hosting and bandwidth
      personally, and provides this map to the amateur radio community at no cost.
    </p>
    <p class="prose">
      To prevent abuse from other apps, the map server requires a one-time
      registration per device.
    </p>
    <h3 class="prose-heading">What is sent</h3>
    <p class="prose">
      At registration, and again every time you load map tiles or download
      offline state maps:
    </p>
    <ul class="prose-list">
      <li>Your callsign (uppercase, without -SSID).</li>
      <li>Your IP address, captured by the server.</li>
    </ul>
    <p class="prose">
      Nothing else. No email, no name, no metadata. Each install registers
      independently -- your laptop and your tablet each get their own token.
    </p>
    <Toggle
      class="consent-toggle"
      checked={consented}
      onCheckedChange={(v) => (consented = v)}
      label="I understand and agree."
    />
  </Box>

  <Box title="Register this device">
    <label for="maps-callsign-input" class="maps-input-label-text">Your callsign</label>
    <div class="maps-row maps-row-aligned">
      <div class="maps-callsign-input">
        <Input
          id="maps-callsign-input"
          type="text"
          placeholder="YOUR CALLSIGN"
          bind:value={callsignInput}
          autocapitalize="characters"
          autocomplete="off"
          spellcheck={false}
          inputmode="text"
          disabled={!consented}
        />
      </div>
      <Button
        class="maps-cta"
        variant="primary"
        disabled={!canSubmit}
        onclick={onRegister}
      >
        {mapsState.registering ? 'Registering...' : 'Register'}
      </Button>
    </div>

    {#if callsignInput && !validation.ok}
      <p class="form-hint form-hint-error">{validation.message}</p>
    {:else if !consented}
      <p class="form-hint">Tick "I understand and agree" above to continue.</p>
    {:else}
      <p class="form-hint">We will send <code>{validation.callsign ?? '...'}</code> to <code>auth.nw5w.com</code>.</p>
    {/if}

    {#if lastError}
      <div class="error-card" role="alert">
        <h3>Registration failed</h3>
        <p>{lastError.message}</p>
        {#if lastError.code === 'device_limit_reached'}
          <p>This callsign has reached its 40-device limit. Please open an issue at the link below so the operator can rotate tokens for you.</p>
        {:else if lastError.code === 'rate_limited'}
          <p>Wait about 10 seconds and try again.</p>
        {:else if lastError.code === 'blocked'}
          <p>This callsign has been blocked. Please open an issue at the link below to ask the operator about it.</p>
        {/if}
        <a class="error-link" href={ISSUES_URL} target="_blank" rel="noreferrer noopener">
          Open a GitHub issue
        </a>
      </div>
    {/if}
  </Box>
{/if}

{#if mapsState.registered}
  <Box title="Registered">
    <p class="prose">
      This device is registered as <code>{mapsState.callsign}</code>.
      {#if mapsState.registeredAt}
        Registered {mapsState.registeredAt.toLocaleString()}.
      {/if}
    </p>

    <p class="form-hint">
      If something goes wrong with this device's registration, click below to
      get a fresh one. Your other devices keep working.
    </p>
    <div class="maps-row">
      <Button
        class="maps-cta"
        variant="default"
        onclick={onReregister}
        disabled={mapsState.registering}
      >
        {mapsState.registering ? 'Re-registering...' : 'Re-register this device'}
      </Button>
    </div>

    {#if lastError}
      <div class="error-card" role="alert">
        <h3>Re-registration failed</h3>
        <p>{lastError.message}</p>
        <a class="error-link" href={ISSUES_URL} target="_blank" rel="noreferrer noopener">
          Open a GitHub issue
        </a>
      </div>
    {/if}
  </Box>
{/if}

<Box title="Map source">
  <RadioGroup
    value={mapsState.source}
    onValueChange={onSourceChange}
    name="map-source"
    class="source-radio-group"
    aria-label="Choose a basemap source"
  >
    {#each sources as src}
      <div
        class="source-radio-row"
        class:source-radio-graywolf={src.value === 'graywolf'}
        style:--source-icon-url={src.value === 'graywolf' ? `url(${wolfLogoUrl})` : null}
      >
        <Radio
          value={src.value}
          label={src.label}
          disabled={isDisabled(src)}
        />
        <p class="source-sublabel">{src.sublabel}</p>
      </div>
      {#if src.value === 'graywolf' && mapsState.source === 'graywolf' && downloadsState.completed.size > 0}
        {@const cat = catalogStore.catalog}
        {@const total = cat ? cat.countries.length + cat.provinces.length + cat.states.length : 0}
        <p class="source-offline-hint">
          {#if total > 0}
            Using offline tiles for {downloadsState.completed.size}
            of {total} region{total === 1 ? '' : 's'}.
          {:else}
            Using offline tiles for {downloadsState.completed.size}
            region{downloadsState.completed.size === 1 ? '' : 's'}.
          {/if}
          Areas without offline coverage fall back to online.
        </p>
      {/if}
    {/each}
  </RadioGroup>
</Box>

<Box title="Radar region">
  <p class="prose">
    Choose which radar overlay the live map shows. NEXRAD covers the United
    States; RainViewer covers the rest of the world.
  </p>
  <RadioGroup
    value={mapState.radarRegion}
    onValueChange={onRadarRegionChange}
    name="radar-region"
    class="source-radio-group"
    aria-label="Choose a radar region"
  >
    {#each radarRegions as region}
      <div class="source-radio-row">
        <Radio value={region.value} label={region.label} />
        <p class="source-sublabel">{region.sublabel}</p>
      </div>
    {/each}
  </RadioGroup>
</Box>

{#if mapsState.registered}
  <Box title="Offline maps">
    <p class="prose">
      Download vector tiles for countries, US states, and Canadian provinces
      for off-grid use. The map will use these automatically where coverage
      exists; it falls back to online tiles for areas you have not downloaded.
    </p>

    {#if activeDownloads.length > 0}
      <h3 class="prose-heading">In progress</h3>
      <ul class="downloaded-list">
        {#each activeDownloads as row (row.slug)}
          <li class="downloaded-row">
            <span class="downloaded-name">{row.name}</span>
            <span class="downloaded-meta">
              {#if row.state === 'downloading'}
                {formatBytes(row.bytes_downloaded)}
                {#if row.bytes_total > 0}
                  / {formatBytes(row.bytes_total)}
                  ({Math.round((row.bytes_downloaded / row.bytes_total) * 100)}%)
                {/if}
              {:else if row.state === 'error'}
                <span class="status-error">Error: {row.error_message || 'Download failed'}</span>
              {:else}
                Pending...
              {/if}
            </span>
            {#if row.state === 'error'}
              <Button variant="default" onclick={() => downloadsState.remove(row.slug)}>Dismiss</Button>
            {:else}
              <Button variant="danger" onclick={() => downloadsState.cancel(row.slug)}>Cancel</Button>
            {/if}
            {#if row.state === 'downloading' && row.bytes_total > 0}
              <progress class="downloaded-progress" value={row.bytes_downloaded} max={row.bytes_total}></progress>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if downloadedRows.length === 0 && activeDownloads.length === 0}
      <p class="form-hint">No regions downloaded yet.</p>
    {:else if downloadedRows.length > 0}
      <h3 class="prose-heading">Downloaded ({downloadedRows.length})</h3>
      <ul class="downloaded-list">
        {#each downloadedRows as row (row.slug)}
          <li class="downloaded-row">
            <span class="downloaded-name">{row.name}</span>
            <span class="downloaded-meta">
              {formatBytes(row.bytes_total)}
              {#if row.downloaded_at}
                · {new Date(row.downloaded_at).toLocaleDateString()}
              {/if}
            </span>
            <Button variant="default" onclick={() => downloadsState.start(row.slug)}>Re-download</Button>
            <Button variant="danger" onclick={() => downloadsState.remove(row.slug)}>Delete</Button>
          </li>
        {/each}
      </ul>
    {/if}

    <Button class="maps-cta" onclick={() => (pickerOpen = true)}>
      Add a region
    </Button>
  </Box>

  <RegionPicker bind:open={pickerOpen} />
{/if}

<Box title="Route overlays">
  <p class="prose">
    Upload a route to draw it on the live map as a reference line -- e.g. an
    event course exported from Ride With GPS as a GPX track. Routes are stored
    on this server and shared with every device. Toggle them on the map's
    Layers panel under "Routes". GPX, KML, and GeoJSON files are accepted.
  </p>

  <input
    type="file"
    accept=".gpx,.kml,.geojson,.json,application/gpx+xml,application/vnd.google-earth.kml+xml,application/geo+json"
    class="route-file-input"
    bind:this={routeFileInput}
    onchange={onRouteFileChange}
  />
  <Button class="maps-cta" disabled={routeUploading} onclick={() => routeFileInput?.click()}>
    {routeUploading ? 'Importing...' : 'Upload route'}
  </Button>

  {#if mapRoutesStore.routes.length === 0}
    <p class="form-hint">No routes uploaded yet.</p>
  {:else}
    <h3 class="prose-heading">Routes ({mapRoutesStore.routes.length})</h3>
    <ul class="route-list">
      {#each mapRoutesStore.routes as route (route.id)}
        <li class="route-row">
          <input
            type="color"
            class="route-color"
            aria-label="Route line color"
            value={route.color}
            onchange={(e) => commitRouteColor(route, e.currentTarget.value)}
          />
          <input
            class="route-name"
            value={route.name}
            aria-label="Route name"
            onblur={(e) => commitRouteName(route, e.currentTarget.value)}
          />
          <span class="route-meta">{route.pointCount} pts</span>
          <Button variant="danger" onclick={() => askDeleteRoute(route)}>Delete</Button>
        </li>
      {/each}
    </ul>
  {/if}
</Box>

<ConfirmDialog
  bind:open={routeDeleteOpen}
  title="Delete route"
  message={routeDeleteTarget
    ? `Delete "${routeDeleteTarget.name}"? This removes it from the map on every device and cannot be undone.`
    : ''}
  confirmLabel="Delete"
  onConfirm={confirmDeleteRoute}
/>

<style>
  @import '../lib/maps/styles.css';

  .maps-input-label-text {
    display: block;
    margin-bottom: 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  /* Route overlays card: hidden native file input (triggered by the
     chonky Button), and a per-route row of color swatch + editable name
     + point count + delete. */
  .route-file-input {
    display: none;
  }
  .route-list {
    list-style: none;
    margin: 12px 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .route-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }
  .route-color {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: none;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .route-name {
    flex: 1 1 auto;
    min-width: 0;
    padding: 4px 8px;
    font: inherit;
    color: var(--text-primary);
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
  }
  .route-meta {
    font-size: 12px;
    color: var(--text-muted);
    flex: 0 0 auto;
  }
</style>
