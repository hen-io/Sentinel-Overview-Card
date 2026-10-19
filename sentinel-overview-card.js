
const CARD_VERSION = "0.2.0";
const CARD_TAG = "sentinel-overview-card";
const LEGACY_CARD_TAG = "k93-ans-overview-card";
const IMPORTANCE_LEVELS = ["low", "normal", "high", "critical"];

function fireDomEvent(node, type, detail) {
  const event = new CustomEvent(type, { bubbles: true, cancelable: false, composed: true, detail });
  node.dispatchEvent(event);
  return event;
}

function handleTapAction(node, hass, actionConfig) {
  const config = actionConfig || { action: "none" };
  switch (config.action) {
    case "navigate":
      if (config.navigation_path) {
        if (config.navigation_replace) {
          history.replaceState(null, "", config.navigation_path);
        } else {
          history.pushState(null, "", config.navigation_path);
        }
        fireDomEvent(window, "location-changed", { replace: Boolean(config.navigation_replace) });
      }
      break;
    case "url":
      if (config.url_path) {
        window.open(config.url_path, config.new_tab === false ? "_self" : "_blank");
      }
      break;
    case "more-info":
      if (config.entity) {
        fireDomEvent(node, "hass-more-info", { entityId: config.entity });
      }
      break;
    case "toggle":
      if (config.entity && hass) {
        hass.callService("homeassistant", "toggle", {}, { entity_id: config.entity });
      }
      break;
    case "call-service":
    case "perform-action": {
      const serviceStr = config.perform_action || config.service;
      if (serviceStr && hass) {
        const [domain, service] = serviceStr.split(".");
        hass.callService(domain, service, config.data || config.service_data || {}, config.target);
      }
      break;
    }
    default:
      break;
  }
}

const BUILTIN_CHANNEL_KEYS = ["info", "alert", "event", "reminder", "security", "system", "chat"];

const LOCALE_TAG = { en: "en", no: "nb-NO" };

const STRINGS = {
  en: {
    unacknowledged: "Unacknowledged",
    history: "History",
    nothing: "Nothing to show",
    acknowledge: "Acknowledge",
    delete: "Delete",
    clear_history: "Clear",
    filter: "Filter",
    confirm_clear_history: "Clear all history? This can't be undone.",
    today: "Today",
    yesterday: "Yesterday",
    importance: { low: "Low", normal: "Normal", high: "High", critical: "Critical" },
  },
  no: {
    unacknowledged: "Ikke bekreftet",
    history: "Historikk",
    nothing: "Ingenting å vise",
    acknowledge: "Bekreft",
    delete: "Slett",
    clear_history: "Tøm",
    filter: "Filtrer",
    confirm_clear_history: "Tøm all historikk? Dette kan ikke angres.",
    today: "I dag",
    yesterday: "I går",
    importance: { low: "Lav", normal: "Normal", high: "Høy", critical: "Kritisk" },
  },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function importanceRank(level) {
  const idx = IMPORTANCE_LEVELS.indexOf(level);
  return idx === -1 ? IMPORTANCE_LEVELS.indexOf("normal") : idx;
}

const CHANNEL_IMPORTANCE_PREFIX = "history_channel_importance__";
const CHANNEL_LABELS_PREFIX = "history_channel_labels__";

function prefixedConfigMap(cfg, prefix) {
  const map = {};
  for (const [key, value] of Object.entries(cfg || {})) {
    if (key.startsWith(prefix) && value && (!Array.isArray(value) || value.length)) {
      map[key.slice(prefix.length).toLowerCase()] = value;
    }
  }
  return map;
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function recordChannelKeys(record) {
  const channels = Array.isArray(record.channels) && record.channels.length ? record.channels : [record.channel];
  return channels.map(lower);
}

function recordLabelKeys(record) {
  return (Array.isArray(record.labels) ? record.labels : []).map(lower);
}

function matchesFilter(record, filter) {
  if (record.show_in_history === false) return false;
  const selected = (filter.channels || []).map(lower);
  const recordChannels = recordChannelKeys(record);
  const inList = selected.some((c) => recordChannels.includes(c));
  if (filter.mode === "exclude" ? inList : selected.length && !inList) return false;

  const rank = importanceRank(record.importance);
  if (filter.mode !== "exclude" && selected.length) {
    const labels = recordLabelKeys(record);
    return recordChannels
      .filter((c) => selected.includes(c))
      .some((c) => {
        const threshold = filter.channelImportance?.[c] || filter.minImportance || "low";
        const wanted = (filter.channelLabels?.[c] || []).map(lower);
        return rank >= importanceRank(threshold) && (!wanted.length || wanted.some((l) => labels.includes(l)));
      });
  }
  return rank >= importanceRank(filter.minImportance || "low");
}

const WS_PREFIXES = ["sentinel", "k93_ans"];
let wsPrefix = null;

class SentinelApi {
  constructor() {
    this.hass = null;
  }

  get legacy() {
    return wsPrefix !== null && wsPrefix !== WS_PREFIXES[0];
  }

  async _withPrefix(fn) {
    if (wsPrefix) return fn(wsPrefix);
    let lastError;
    for (const prefix of WS_PREFIXES) {
      try {
        const result = await fn(prefix);
        wsPrefix = prefix;
        return result;
      } catch (err) {
        if (err?.code !== "unknown_command") throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  call(name, params = {}) {
    return this._withPrefix((prefix) => this.hass.callWS({ ...params, type: `${prefix}/${name}` }));
  }

  subscribe(name, onEvent, params = {}) {
    return this._withPrefix((prefix) =>
      this.hass.connection.subscribeMessage(onEvent, { ...params, type: `${prefix}/${name}` })
    );
  }

  async config() {
    if (!this.legacy) {
      try {
        return await this.call("config");
      } catch (err) {
        if (err?.code !== "unknown_command") throw err;
      }
    }
    const sensor = Object.values(this.hass.states).find((s) => Array.isArray(s.attributes?.channels));
    return { channels: sensor ? sensor.attributes.channels : [] };
  }
}

function channelDefs(config) {
  return Array.isArray(config?.channels) ? config.channels : [];
}

function channelColor(config, record) {
  const key = lower(record.channel);
  return channelDefs(config).find((c) => lower(c.key) === key)?.color || "";
}

function labelName(config, key) {
  for (const channel of channelDefs(config)) {
    const label = (channel.labels || []).find((l) => lower(l.key) === lower(key));
    if (label) return label.name;
  }
  return key;
}

function channelOptions(config) {
  const channels = channelDefs(config);
  if (!channels.length) return BUILTIN_CHANNEL_KEYS.map((key) => ({ value: key, label: key }));
  return channels.map((c) => ({
    value: c.key,
    label: c.enabled === false ? `${c.name} (${c.key}, disabled)` : `${c.name} (${c.key})`,
  }));
}

function labelOptions(config, channelKey) {
  const channel = channelDefs(config).find((c) => lower(c.key) === lower(channelKey));
  return (channel?.labels || []).map((l) => ({ value: l.key, label: l.name }));
}

function defineElement(tag, ctor) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

function formatRelativeTime(iso, locale, lang) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const strings = STRINGS[lang] || STRINGS.en;
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return `${strings.today} ${time}`;
  if (diffDays === 1) return `${strings.yesterday} ${time}`;
  if (diffDays > 1 && diffDays < 7) {
    const weekday = date.toLocaleDateString(locale, { weekday: "long" });
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${time}`;
  }
  return `${date.toLocaleDateString(locale)} ${time}`;
}

class SentinelOverviewCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._api = new SentinelApi();
    this._notifications = [];
    this._sentinelConfig = null;
    this._viewFilter = { channel: null, labels: [] };
    this._subscribed = false;
    this._unsubscribe = null;
    this._lightboxSrc = null;
    this._onReconnect = () => this._fetchList();

    this.shadowRoot.addEventListener("click", (event) => {
      const target = event.target;
      const ackButton = target.closest("[data-ack-id]");
      if (ackButton) {
        this._acknowledge(ackButton.dataset.ackId);
        return;
      }
      const deleteButton = target.closest("[data-delete-id]");
      if (deleteButton) {
        this._delete(deleteButton.dataset.deleteId);
        return;
      }
      if (target.closest("[data-clear-history]")) {
        this._clearHistory();
        return;
      }
      const channelChip = target.closest("[data-filter-channel]");
      if (channelChip) {
        const key = channelChip.dataset.filterChannel || null;
        this._viewFilter = { channel: this._viewFilter.channel === key ? null : key, labels: [] };
        this._render();
        return;
      }
      const labelChip = target.closest("[data-filter-label]");
      if (labelChip) {
        const key = labelChip.dataset.filterLabel;
        const labels = this._viewFilter.labels;
        this._viewFilter = {
          ...this._viewFilter,
          labels: labels.includes(key) ? labels.filter((l) => l !== key) : [...labels, key],
        };
        this._render();
        return;
      }
      const lightboxTrigger = target.closest("[data-lightbox-src]");
      if (lightboxTrigger) {
        this._lightboxSrc = lightboxTrigger.dataset.lightboxSrc;
        this._render();
        return;
      }
      if (target.closest("[data-lightbox-close]")) {
        this._lightboxSrc = null;
        this._render();
      }
    });
  }

  setConfig(config) {
    this._config = {
      title: "Notifications",
      title_icon: null,
      title_font_size: 1.1,
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      language: "auto",
      show_unacknowledged: true,
      show_history: true,
      show_channel: true,
      show_labels: true,
      show_importance: true,
      show_clear_history: true,
      show_delete_button: true,
      show_filter_bar: false,
      image_display_mode: "thumbnail",
      history_channels: [],
      history_channels_mode: "include",
      history_min_importance: "low",
      show_ticker: false,
      ticker_limit: 10,
      ticker_font_size: 0.85,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
      tap_action: { action: "none" },
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._api.hass = hass;
    if (!this._subscribed) {
      this._subscribed = true;
      hass.connection.addEventListener("ready", this._onReconnect);
      this._subscribe();
      this._fetchList();
      this._render();
    }
  }

  _lang() {
    const configured = this._config?.language;
    if (configured && configured !== "auto") return configured;
    const hassLang = this._hass?.language || "";
    return /^n[bno]/i.test(hassLang) ? "no" : "en";
  }

  _t(key) {
    const strings = STRINGS[this._lang()] || STRINGS.en;
    return strings[key] ?? STRINGS.en[key] ?? key;
  }

  getCardSize() {
    const cfg = this._config;
    if (cfg?.card_height) {
      return Math.max(1, Math.round(cfg.card_height / 50));
    }
    if (!cfg?.show_unacknowledged && !cfg?.show_history) {
      return cfg?.show_ticker ? 2 : 1;
    }
    const base = cfg?.show_ticker ? 3 : 2;
    return base + Math.min(this._notifications.length, cfg?.max_items ?? 5);
  }

  getGridOptions() {
    const cfg = this._config;
    if (!cfg?.card_height) return undefined;
    const rows = Math.max(1, Math.round((Number(cfg.card_height) + 8) / 64));
    return { rows };
  }

  disconnectedCallback() {
    this._hass?.connection.removeEventListener("ready", this._onReconnect);
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._subscribed = false;
  }

  _historyFilter() {
    const cfg = this._config;
    return {
      channels: cfg.history_channels,
      mode: cfg.history_channels_mode,
      minImportance: cfg.history_min_importance,
      channelImportance: prefixedConfigMap(cfg, CHANNEL_IMPORTANCE_PREFIX),
      channelLabels: prefixedConfigMap(cfg, CHANNEL_LABELS_PREFIX),
    };
  }

  async _subscribe() {
    try {
      this._unsubscribe = await this._api.subscribe("subscribe", (msg) => {
        if (msg.notification) this._onUpdate(msg.notification);
        if (msg.deleted_ids) this._onDelete(msg.deleted_ids);
        if (msg.config) {
          this._sentinelConfig = msg.config;
          this._render();
        }
      });
    } catch (err) {
      console.error(`${CARD_TAG}: failed to subscribe`, err);
    }
  }

  async _fetchList() {
    try {
      const cfg = this._config || {};
      const limit = cfg.max_items ?? 50;
      const results = [await this._api.call("list", { include_acknowledged: true, limit })];
      const more = [this._api.config()];
      if (cfg.history_channels && cfg.history_channels.length) {
        more.push(
          this._api.call("list", {
            include_acknowledged: true,
            limit,
            channels: cfg.history_channels,
            channel_mode: cfg.history_channels_mode || "include",
            min_importance: cfg.history_min_importance || undefined,
          })
        );
      }
      if (!this._api.legacy) more.push(this._api.call("list", { outstanding_only: true }));
      const [config, ...lists] = await Promise.all(more);
      this._sentinelConfig = config;
      const byId = new Map();
      for (const result of [...results, ...lists]) {
        for (const record of result.notifications) byId.set(record.id, record);
      }
      this._notifications = [...byId.values()].sort((a, b) => (a.created < b.created ? 1 : -1));
      this._render();
    } catch (err) {
      console.error(`${CARD_TAG}: failed to load notifications`, err);
    }
  }

  _onUpdate(record) {
    const idx = this._notifications.findIndex((n) => n.id === record.id);
    if (idx >= 0) {
      this._notifications = [
        ...this._notifications.slice(0, idx),
        record,
        ...this._notifications.slice(idx + 1),
      ];
    } else {
      this._notifications = [record, ...this._notifications];
    }
    this._render();
  }

  _onDelete(deletedIds) {
    const idSet = new Set(deletedIds);
    this._notifications = this._notifications.filter((n) => !idSet.has(n.id));
    this._render();
  }

  async _acknowledge(notificationId) {
    try {
      await this._api.call("acknowledge", { notification_id: notificationId });
    } catch (err) {
      console.error(`${CARD_TAG}: failed to acknowledge`, err);
    }
  }

  async _delete(notificationId) {
    try {
      await this._api.call("delete", { notification_ids: [notificationId] });
    } catch (err) {
      console.error(`${CARD_TAG}: failed to delete`, err);
    }
  }

  async _clearHistory() {
    if (!window.confirm(this._t("confirm_clear_history"))) return;
    try {
      await this._api.call("clear_history", { include_unacknowledged: false });
    } catch (err) {
      console.error(`${CARD_TAG}: failed to clear history`, err);
    }
  }

  _channelName(key) {
    return channelDefs(this._sentinelConfig).find((c) => lower(c.key) === lower(key))?.name || key;
  }

  _applyViewFilter(records) {
    const { channel, labels } = this._viewFilter;
    if (!channel) return records;
    return records.filter(
      (r) =>
        recordChannelKeys(r).includes(channel) &&
        (!labels.length || labels.some((l) => recordLabelKeys(r).includes(l)))
    );
  }

  _chipHtml(attr, value, label, selected) {
    const check = selected ? `<ha-icon class="chip-icon" icon="mdi:check"></ha-icon>` : "";
    return (
      `<button type="button" class="chip${selected ? " selected" : ""}" ${attr}="${esc(value)}" ` +
      `aria-pressed="${selected}">${check}<span>${esc(label)}</span></button>`
    );
  }

  _renderFilterBar(history) {
    if (!this._config.show_filter_bar || !history.length) return "";
    const { channel, labels } = this._viewFilter;
    const presentChannels = [...new Set(history.flatMap(recordChannelKeys))];
    const channelChips = presentChannels
      .map((key) => this._chipHtml("data-filter-channel", key, this._channelName(key), channel === key))
      .join("");
    let labelChips = "";
    if (channel) {
      const configured = labelOptions(this._sentinelConfig, channel).map((o) => lower(o.value));
      const present = history.filter((r) => recordChannelKeys(r).includes(channel)).flatMap(recordLabelKeys);
      labelChips = [...new Set([...configured, ...present])]
        .map((key) => this._chipHtml("data-filter-label", key, labelName(this._sentinelConfig, key), labels.includes(key)))
        .join("");
    }
    return (
      `<div class="filter-bar" role="toolbar" aria-label="${esc(this._t("filter"))}">${channelChips}</div>` +
      (labelChips ? `<div class="filter-bar labels">${labelChips}</div>` : "")
    );
  }

  _renderItem(record, locale) {
    const imageMode = this._config.image_display_mode || "thumbnail";
    const showThumbnail = Boolean(record.image) && imageMode === "thumbnail";
    const showFullImage = Boolean(record.image) && imageMode === "full";

    const icon = record.icon || "mdi:bell-outline";
    const color = channelColor(this._sentinelConfig, record);
    const iconHtml = icon.startsWith("mdi:")
      ? `<ha-icon icon="${esc(icon)}"${color ? ` style="color: ${esc(color)};"` : ""}></ha-icon>`
      : `<img class="thumb" src="${esc(icon)}" alt="" />`;

    let leftHtml;
    if (showThumbnail) {
      leftHtml = `
        <img class="row-image" data-lightbox-src="${esc(record.image)}" src="${esc(record.image)}" alt="" loading="lazy" />
        <span class="icon-badge">${iconHtml}</span>
      `;
    } else {
      leftHtml = iconHtml;
    }

    const fullImageHtml = showFullImage
      ? `<img class="row-image-full" data-lightbox-src="${esc(record.image)}" src="${esc(record.image)}" alt="" loading="lazy" />`
      : "";

    const ackButton = (record.requires_ack && !record.acknowledged)
      ? `<button class="ack" data-ack-id="${esc(record.id)}">${esc(this._t("acknowledge"))}</button>`
      : "";

    const deleteButton = (this._config.show_delete_button && (!record.requires_ack || record.acknowledged))
      ? `<button class="delete" data-delete-id="${esc(record.id)}" title="${esc(this._t("delete"))}" aria-label="${esc(this._t("delete"))}"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>`
      : "";

    const importanceHtml = this._config.show_importance
      ? (() => {
          const label = (STRINGS[this._lang()] || STRINGS.en).importance[record.importance]
            || record.importance;
          return `<span class="importance importance-${esc(record.importance)}">${esc(label)}</span>`;
        })()
      : "";

    const metaParts = [];
    if (this._config.show_channel) {
      const channelLabel = Array.isArray(record.channels) && record.channels.length
        ? record.channels.join(", ")
        : record.channel;
      metaParts.push(esc(channelLabel));
    }
    if (this._config.show_labels && recordLabelKeys(record).length) {
      metaParts.push(esc(recordLabelKeys(record).map((key) => labelName(this._sentinelConfig, key)).join(", ")));
    }
    metaParts.push(esc(formatRelativeTime(record.created, locale, this._lang())));

    return `
      <div class="item">
        <div class="icon${showThumbnail ? " icon-image" : ""}">${leftHtml}</div>
        <div class="body">
          <div class="row1">
            <span class="title">${esc(record.title)}</span>
            ${importanceHtml}
          </div>
          <div class="message">${esc(record.message)}</div>
          <div class="meta">${metaParts.join(" &middot; ")}</div>
          ${fullImageHtml}
        </div>
        ${ackButton}${deleteButton}
      </div>
    `;
  }

  _renderLightbox() {
    if (!this._lightboxSrc) return "";
    return `
      <div class="lightbox-overlay" data-lightbox-close>
        <img class="lightbox-image" src="${esc(this._lightboxSrc)}" alt="" />
      </div>
    `;
  }

  _titleIconHtml() {
    const cfg = this._config;
    if (!cfg.title_icon) return "";
    const size = Number(cfg.title_icon_size) || 24;
    const color = cfg.title_icon_color || "var(--primary-text-color)";
    const background = cfg.title_icon_background || "transparent";
    return `
      <span class="title-icon" style="width: ${size}px; height: ${size}px; background: ${esc(background)};">
        <ha-icon icon="${esc(cfg.title_icon)}" style="color: ${esc(color)}; --mdc-icon-size: ${Math.round(size * 0.6)}px;"></ha-icon>
      </span>
    `;
  }

  _tickerItemHtml(record, locale, lang) {
    const icon = record.icon || "mdi:bell-outline";
    const color = channelColor(this._sentinelConfig, record);
    const iconHtml = icon.startsWith("mdi:")
      ? `<ha-icon class="ticker-icon" icon="${esc(icon)}"${color ? ` style="color: ${esc(color)};"` : ""}></ha-icon>`
      : `<img class="ticker-icon-img" src="${esc(icon)}" alt="" />`;
    return (
      `<span class="ticker-item">${iconHtml}` +
      `<span class="ticker-text">${esc(formatRelativeTime(record.created, locale, lang))} : ${esc(record.message)}</span></span>`
    );
  }

  _renderTicker(locale, lang) {
    const cfg = this._config;
    if (!cfg.show_ticker) return "";

    const filter = this._historyFilter();
    const items = (this._notifications || [])
      .filter((n) => matchesFilter(n, filter))
      .slice(0, cfg.ticker_limit ?? 10);

    if (!items.length) return "";

    const sep = `<span class="ticker-sep">&bull;</span>`;
    const group = items.map((n) => this._tickerItemHtml(n, locale, lang)).join(sep) + sep;
    const speed = Number(cfg.ticker_speed) || 1;
    const BASE_LOOP_SECONDS = Math.min(items.length * 5, 120);
    const duration = Math.max(4, BASE_LOOP_SECONDS / speed);
    const fontSize = Number(cfg.ticker_font_size) || 0.85;

    const iconHtml = this._titleIconHtml();

    return `
      <div class="ticker-wrap">
        ${iconHtml}
        <div class="ticker-viewport">
          <div class="ticker-track" style="animation-duration: ${duration}s; font-size: ${fontSize}em;">
            ${group}${group}
          </div>
        </div>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;

    const cfg = this._config;
    const lang = this._lang();
    const locale = LOCALE_TAG[lang] || undefined;
    const all = this._notifications || [];
    const unacknowledged = all.filter(
      (n) => n.requires_ack && !n.acknowledged && n.show_in_history !== false
    );
    const filter = this._historyFilter();
    const history = all.filter((n) => matchesFilter(n, filter));

    const sections = [];
    if (cfg.show_unacknowledged) {
      sections.push({
        key: "unacknowledged",
        label: `${this._t("unacknowledged")}${unacknowledged.length ? ` (${unacknowledged.length})` : ""}`,
        items: unacknowledged,
      });
    }
    if (cfg.show_history) {
      sections.push({ key: "history", label: this._t("history"), items: this._applyViewFilter(history) });
    }

    const body = sections
      .map((section) => {
        const clearButton = (section.key === "history" && cfg.show_clear_history && section.items.length)
          ? `<button class="clear-history" data-clear-history>${esc(this._t("clear_history"))}</button>`
          : "";
        return `
          <div class="section">
            <div class="section-title-row">
              <div class="section-title">${esc(section.label)}</div>
              ${clearButton}
            </div>
            ${section.key === "history" ? this._renderFilterBar(history) : ""}
            ${
              section.items.length
                ? section.items.map((item) => this._renderItem(item, locale)).join("")
                : `<div class="empty">${esc(this._t("nothing"))}</div>`
            }
          </div>
        `;
      })
      .join("");

    const tickerHtml = this._renderTicker(locale, lang);
    const iconInTicker = Boolean(cfg.show_ticker && cfg.title_icon && tickerHtml);
    const headerIconHtml = iconInTicker ? "" : this._titleIconHtml();

    const cardThemeStyles = [];
    if (cfg.card_height) cardThemeStyles.push(`height: ${Number(cfg.card_height)}px`);
    if (cfg.card_background_color) cardThemeStyles.push(`background: ${cfg.card_background_color}`);
    if (cfg.card_border_radius != null && cfg.card_border_radius !== "") {
      cardThemeStyles.push(`border-radius: ${Number(cfg.card_border_radius)}px`);
    }
    if (cfg.card_border_color || (cfg.card_border_width != null && cfg.card_border_width !== "")) {
      cardThemeStyles.push(`border-style: solid`);
      if (cfg.card_border_color) cardThemeStyles.push(`border-color: ${cfg.card_border_color}`);
      if (cfg.card_border_width != null && cfg.card_border_width !== "") {
        cardThemeStyles.push(`border-width: ${Number(cfg.card_border_width)}px`);
      }
    }
    if (!this._built) {
      this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .card-header {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 16px 16px 8px;
          font-weight: 500;
        }
        .card-header.tappable { cursor: pointer; }
        .title-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          flex-shrink: 0;
        }

        .ticker-wrap {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 10px 16px;
          border-bottom: 1px solid var(--divider-color);
          box-sizing: border-box;
        }
        .ticker-viewport {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          -webkit-mask-image: linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%);
          mask-image: linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%);
        }
        .ticker-track {
          display: inline-block;
          white-space: nowrap;
          animation-name: sentinel-ticker;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          color: var(--primary-text-color);
          line-height: 1.4;
        }
        .ticker-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          line-height: 1;
          vertical-align: middle;
        }
        .ticker-text {
          display: inline-flex;
          align-items: center;
          line-height: 1;
        }
        .ticker-icon {
          --mdc-icon-size: 1em;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1em;
          height: 1em;
          color: var(--primary-text-color);
          flex-shrink: 0;
        }
        .ticker-icon-img {
          display: inline-block;
          width: 1em;
          height: 1em;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          vertical-align: middle;
        }
        .ticker-sep {
          display: inline-flex;
          align-items: center;
          margin: 0 12px;
          opacity: 0.5;
        }
        @keyframes sentinel-ticker {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }

        /* MD3 filter chips: 32px, 8px corners, label-large, state layer, check icon when selected. */
        .filter-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 0 16px 8px;
        }
        .chip {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          height: 32px;
          padding: 0 16px;
          box-sizing: border-box;
          border: 1px solid var(--md-sys-color-outline-variant, var(--outline-color, var(--divider-color)));
          border-radius: 8px;
          background: transparent;
          color: var(--md-sys-color-on-surface-variant, var(--secondary-text-color));
          font-family: inherit;
          font-size: 14px;
          font-weight: 500;
          line-height: 20px;
          letter-spacing: 0.1px;
          cursor: pointer;
          overflow: hidden;
        }
        .chip::before {
          content: "";
          position: absolute;
          inset: 0;
          background: currentColor;
          opacity: 0;
          transition: opacity 15ms linear;
        }
        .chip:hover::before { opacity: 0.08; }
        .chip:focus-visible { outline: 2px solid var(--md-sys-color-secondary, var(--primary-color)); outline-offset: 2px; }
        .chip:focus-visible::before, .chip:active::before { opacity: 0.1; }
        .chip.selected {
          padding-left: 8px;
          border-color: transparent;
          background: var(--md-sys-color-secondary-container, color-mix(in srgb, var(--primary-color, #0a84ff) 20%, transparent));
          color: var(--md-sys-color-on-secondary-container, var(--primary-text-color));
        }
        .chip-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; }

        .scroll-area {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          scrollbar-width: thin;
        }
        .scroll-area:empty { display: none; }

        .section-title-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px 6px 16px;
        }
        .section-title {
          font-size: 0.78em;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          color: var(--secondary-text-color);
        }
        .clear-history {
          border: none;
          border-radius: 8px;
          padding: 3px 8px;
          font-size: 0.72em;
          font-weight: 600;
          color: var(--secondary-text-color);
          background: transparent;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .clear-history:hover {
          background: color-mix(in srgb, var(--error-color, #ff453a) 12%, transparent);
          color: var(--error-color, #ff453a);
        }
        .empty {
          padding: 4px 16px 14px;
          color: var(--secondary-text-color);
          font-size: 0.9em;
        }
        .item {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--divider-color);
          transition: background 0.15s ease;
        }
        .item:hover { background: color-mix(in srgb, var(--primary-text-color, #000) 4%, transparent); }
        .icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          color: var(--secondary-text-color);
          flex-shrink: 0;
          margin-top: 2px;
        }
        .thumb { width: 22px; height: 22px; border-radius: 5px; object-fit: cover; }
        .icon-image { width: auto; height: auto; max-width: 64px; max-height: 64px; position: relative; }
        .icon-badge {
          position: absolute;
          right: -4px;
          bottom: -4px;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--card-background-color, var(--ha-card-background, #fff));
          box-shadow: 0 0 0 1px var(--divider-color);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .icon-badge ha-icon { --mdc-icon-size: 12px; color: var(--secondary-text-color); }
        .icon-badge .thumb { width: 12px; height: 12px; border-radius: 50%; }
        .row-image {
          display: block;
          max-width: 64px;
          max-height: 64px;
          width: auto;
          height: auto;
          border-radius: 8px;
          cursor: zoom-in;
        }
        .row-image-full {
          display: block;
          width: 100%;
          max-width: 100%;
          height: auto;
          border-radius: 8px;
          margin-top: 8px;
          cursor: zoom-in;
        }
        .lightbox-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.85);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
          z-index: 1000;
          cursor: zoom-out;
        }
        .lightbox-image {
          max-width: 100%;
          max-height: 100%;
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        }
        .body { flex: 1; min-width: 0; }
        .row1 { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
        .title {
          flex: 1;
          min-width: 0;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .importance {
          flex-shrink: 0;
          font-size: 0.72em;
          white-space: nowrap;
          color: var(--secondary-text-color);
        }
        .importance-high, .importance-critical { color: var(--error-color, #ff453a); }
        .message { color: var(--primary-text-color); font-size: 0.95em; margin-top: 2px; }
        .meta { color: var(--secondary-text-color); font-size: 0.78em; margin-top: 4px; }
        .ack {
          align-self: center;
          border: none;
          border-radius: 8px;
          padding: 6px 12px;
          font-size: 0.78em;
          font-weight: 600;
          color: var(--primary-color, #0a84ff);
          cursor: pointer;
          background: color-mix(in srgb, var(--primary-color, #0a84ff) 12%, transparent);
          transition: background 0.15s ease;
          flex-shrink: 0;
        }
        .ack:hover { background: color-mix(in srgb, var(--primary-color, #0a84ff) 20%, transparent); }
        .delete {
          align-self: center;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          border-radius: 8px;
          padding: 6px;
          color: var(--secondary-text-color);
          background: transparent;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
          flex-shrink: 0;
        }
        .delete ha-icon { --mdc-icon-size: 18px; }
        .delete:hover {
          background: color-mix(in srgb, var(--error-color, #ff453a) 12%, transparent);
          color: var(--error-color, #ff453a);
        }
      </style>
      <ha-card>
        <div class="ticker-host"></div>
        <div class="card-header"></div>
        <div class="scroll-area"></div>
      </ha-card>
      <div class="lightbox-host"></div>
      `;
      this._built = true;
      this._cardEl = this.shadowRoot.querySelector("ha-card");
      this._tickerHostEl = this.shadowRoot.querySelector(".ticker-host");
      this._headerEl = this.shadowRoot.querySelector(".card-header");
      this._scrollAreaEl = this.shadowRoot.querySelector(".scroll-area");
      this._lightboxHostEl = this.shadowRoot.querySelector(".lightbox-host");
      this._headerEl.addEventListener("click", () => {
        if (this._config?.tap_action?.action) {
          handleTapAction(this, this._hass, this._config.tap_action);
        }
      });
    }

    if (cardThemeStyles.length) {
      this._cardEl.setAttribute("style", cardThemeStyles.join("; "));
    } else {
      this._cardEl.removeAttribute("style");
    }

    if (tickerHtml !== this._lastTickerHtml) {
      this._lastTickerHtml = tickerHtml;
      this._tickerHostEl.innerHTML = tickerHtml;
    }

    this._headerEl.setAttribute("style", `font-size: ${Number(cfg.title_font_size) || 1.1}em;`);
    this._headerEl.innerHTML = `${headerIconHtml}<span>${esc(cfg.title)}</span>`;
    const hasTapAction = Boolean(cfg.tap_action && cfg.tap_action.action && cfg.tap_action.action !== "none");
    this._headerEl.classList.toggle("tappable", hasTapAction);

    this._scrollAreaEl.innerHTML = body;
    this._lightboxHostEl.innerHTML = this._renderLightbox();
  }

  static getStubConfig() {
    return {
      title: "Notifications",
      title_icon: null,
      title_font_size: 1.1,
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      language: "auto",
      show_unacknowledged: true,
      show_history: true,
      show_channel: true,
      show_labels: true,
      show_importance: true,
      show_clear_history: true,
      show_delete_button: true,
      show_filter_bar: false,
      image_display_mode: "thumbnail",
      history_channels: [],
      history_channels_mode: "include",
      history_min_importance: "low",
      show_ticker: false,
      ticker_limit: 10,
      ticker_font_size: 0.85,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
      tap_action: { action: "none" },
    };
  }

  static getConfigElement() {
    return document.createElement(`${CARD_TAG}-editor`);
  }
}

class SentinelOverviewCardEditor extends HTMLElement {
  constructor() {
    super();
    this._api = new SentinelApi();
    this._sentinelConfig = null;
  }

  setConfig(config) {
    this._config = config;
    this._updateForm();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._api.hass = hass;
    if (first) this._loadConfig();
    this._updateForm();
  }

  async _loadConfig() {
    try {
      this._sentinelConfig = await this._api.config();
      this._updateForm();
    } catch (err) {
      console.error(`${CARD_TAG}-editor: failed to load channels`, err);
    }
  }

  connectedCallback() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (item) => this._label(item.name);
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
        );
      });
      this.appendChild(this._form);

      const versionEl = document.createElement("div");
      versionEl.textContent = `Sentinel Overview Card v${CARD_VERSION}`;
      versionEl.style.cssText = "text-align: right; font-size: 0.75em; opacity: 0.5; padding: 4px 2px 0;";
      this.appendChild(versionEl);
    }
    this._updateForm();
  }

  _label(name) {
    for (const [prefix, suffix] of [
      [CHANNEL_IMPORTANCE_PREFIX, "minimum importance"],
      [CHANNEL_LABELS_PREFIX, "labels (empty = all)"],
    ]) {
      if (name.startsWith(prefix)) {
        const key = name.slice(prefix.length);
        const option = channelOptions(this._sentinelConfig).find((o) => o.value === key);
        return `${option ? option.label : key}: ${suffix}`;
      }
    }
    return SentinelOverviewCardEditor.LABELS[name] || name;
  }

  _schema() {
    const importanceOptions = IMPORTANCE_LEVELS.map((value) => ({ value, label: STRINGS.en.importance[value] }));
    const select = (options, extra = {}) => ({ select: { options, ...extra } });

    const selectedChannels = (this._config?.history_channels_mode || "include") !== "exclude"
      ? (this._config?.history_channels || [])
      : [];
    const perChannelFields = selectedChannels.flatMap((key) => {
      const fields = [
        {
          name: `${CHANNEL_IMPORTANCE_PREFIX}${key}`,
          selector: select([{ value: "", label: "(use global default)" }, ...importanceOptions]),
        },
      ];
      const labels = labelOptions(this._sentinelConfig, key);
      if (labels.length) {
        fields.push({
          name: `${CHANNEL_LABELS_PREFIX}${key}`,
          selector: select(labels, { multiple: true, custom_value: true }),
        });
      }
      return fields;
    });

    return [
      { name: "title", selector: { text: {} } },
      { name: "title_icon", selector: { icon: {} } },
      { name: "title_font_size", selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } } },
      {
        name: "title_icon_size",
        selector: { number: { min: 12, max: 64, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "title_icon_color", selector: { text: {} } },
      { name: "title_icon_background", selector: { text: {} } },
      {
        name: "language",
        selector: select([
          { value: "auto", label: "Automatic (match Home Assistant)" },
          { value: "en", label: "English" },
          { value: "no", label: "Norsk" },
        ]),
      },
      { name: "show_unacknowledged", selector: { boolean: {} } },
      { name: "show_history", selector: { boolean: {} } },
      { name: "show_channel", selector: { boolean: {} } },
      { name: "show_labels", selector: { boolean: {} } },
      { name: "show_importance", selector: { boolean: {} } },
      { name: "show_clear_history", selector: { boolean: {} } },
      { name: "show_delete_button", selector: { boolean: {} } },
      { name: "show_filter_bar", selector: { boolean: {} } },
      {
        name: "image_display_mode",
        selector: select([
          { value: "thumbnail", label: "Thumbnail to the left" },
          { value: "full", label: "Full-size, under the notification" },
          { value: "none", label: "Do not display" },
        ]),
      },
      {
        name: "history_channels_mode",
        selector: select([
          { value: "include", label: "Show only selected channels" },
          { value: "exclude", label: "Hide selected channels" },
        ]),
      },
      {
        name: "history_channels",
        selector: select(channelOptions(this._sentinelConfig), { multiple: true, custom_value: true }),
      },
      { name: "history_min_importance", selector: select(importanceOptions) },
      ...perChannelFields,
      { name: "show_ticker", selector: { boolean: {} } },
      { name: "ticker_limit", selector: { number: { min: 1, max: 500, mode: "box" } } },
      { name: "ticker_font_size", selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } } },
      { name: "ticker_speed", selector: { number: { min: 0.25, max: 4, step: 0.25, mode: "box" } } },
      { name: "max_items", selector: { number: { min: 1, max: 500, mode: "box" } } },
      {
        name: "card_height",
        selector: { number: { min: 60, max: 2000, step: 10, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "card_background_color", selector: { text: {} } },
      {
        name: "card_border_radius",
        selector: { number: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "card_border_color", selector: { text: {} } },
      {
        name: "card_border_width",
        selector: { number: { min: 0, max: 20, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "tap_action", selector: { ui_action: {} } },
    ];
  }

  _updateForm() {
    if (!this._form || !this._config) return;
    this._form.hass = this._hass;
    const schema = this._schema();
    const schemaJson = JSON.stringify(schema);
    if (schemaJson !== this._schemaJson) {
      this._schemaJson = schemaJson;
      this._form.schema = schema;
    }
    this._form.data = this._config;
  }
}

SentinelOverviewCardEditor.LABELS = {
  title: "Title",
  title_icon: "Title icon",
  title_font_size: "Title font size (em)",
  title_icon_size: "Title icon size (px)",
  title_icon_color: "Title icon color (CSS color, blank = theme text color)",
  title_icon_background: "Title icon backdrop (CSS color, blank = none)",
  language: "Language",
  show_unacknowledged: "Show unacknowledged section",
  show_history: "Show history section",
  show_channel: "Show channel on each notification",
  show_labels: "Show labels on each notification",
  show_importance: "Show importance on each notification",
  show_clear_history: "Show \"Clear\" button on the History section",
  show_delete_button: "Show delete button on history rows",
  show_filter_bar: "Show channel/label filter chips above History",
  image_display_mode: "Image display mode",
  history_channels_mode: "Channel filter mode for History + ticker",
  history_channels: "Channels for History + ticker (empty = no filter; suggests configured channels)",
  history_min_importance: "Minimum importance for History + ticker",
  show_ticker: "Show scrolling ticker",
  ticker_limit: "Ticker: max items (separate from \"Max records fetched\" below)",
  ticker_font_size: "Ticker: font size (em)",
  ticker_speed: "Ticker: scroll speed (x)",
  max_items: "Max records fetched (History; ticker uses its own limit above)",
  card_height: "Card height (px, blank = auto)",
  card_background_color: "Card background color override (CSS color, blank = theme default)",
  card_border_radius: "Card corner radius override (px, blank = theme default)",
  card_border_color: "Card border color override (CSS color, blank = theme default)",
  card_border_width: "Card border width override (px, blank = theme default)",
  tap_action: "Tap action (title/icon row)",
};

defineElement(CARD_TAG, SentinelOverviewCard);
defineElement(`${CARD_TAG}-editor`, SentinelOverviewCardEditor);
defineElement(LEGACY_CARD_TAG, class extends SentinelOverviewCard {});
defineElement(`${LEGACY_CARD_TAG}-editor`, class extends SentinelOverviewCardEditor {});

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Sentinel Overview Card",
  description: "Sentinel notification history and unacknowledged notifications, filterable by channel and label.",
});
