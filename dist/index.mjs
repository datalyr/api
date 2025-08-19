// src/index.ts
var Datalyr = class {
  constructor(config) {
    this.queue = [];
    this.isFlushing = false;
    this.isClosing = false;
    if (typeof config === "string") {
      this.apiKey = config;
      this.host = "https://api.datalyr.com";
      this.debug = false;
      this.flushAt = 20;
      this.flushInterval = 1e4;
      this.timeout = 1e4;
      this.retryLimit = 3;
      this.maxQueueSize = 1e3;
    } else {
      this.apiKey = config.apiKey;
      this.host = config.host || "https://api.datalyr.com";
      this.debug = config.debug || false;
      this.flushAt = config.flushAt || 20;
      this.flushInterval = config.flushInterval || 1e4;
      this.timeout = config.timeout || 1e4;
      this.retryLimit = config.retryLimit || 3;
      this.maxQueueSize = config.maxQueueSize || 1e3;
    }
    if (!this.apiKey) {
      throw new Error("Datalyr API key is required");
    }
    if (!this.apiKey.startsWith("dk_")) {
      console.warn('[Datalyr] API key should start with "dk_"');
    }
    if (this.flushAt < 1) this.flushAt = 1;
    if (this.flushAt > 100) this.flushAt = 100;
    if (this.timeout < 1e3) this.timeout = 1e3;
    if (this.timeout > 6e4) this.timeout = 6e4;
    if (this.maxQueueSize < 100) this.maxQueueSize = 100;
    if (this.maxQueueSize > 1e4) this.maxQueueSize = 1e4;
    this.startFlushTimer();
  }
  async track(userId, event, properties) {
    if (this.isClosing) {
      if (this.debug) {
        console.warn("[Datalyr] SDK is closing, event dropped:", event);
      }
      return;
    }
    if (!event || typeof event !== "string") {
      throw new Error("Event name is required and must be a string");
    }
    const trackEvent = {
      userId: userId || void 0,
      anonymousId: userId ? void 0 : this.generateAnonymousId(),
      event,
      properties: properties || {},
      context: {
        library: "@datalyr/api",
        version: "1.0.3"
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.enqueue(trackEvent);
  }
  async identify(userId, traits) {
    if (!userId) {
      throw new Error("userId is required for identify");
    }
    return this.track(userId, "$identify", { $set: traits });
  }
  async page(userId, name, properties) {
    return this.track(userId, "$pageview", { name, ...properties });
  }
  async group(userId, groupId, traits) {
    if (!groupId) {
      throw new Error("groupId is required for group");
    }
    return this.track(userId, "$group", { groupId, traits });
  }
  enqueue(event) {
    if (this.queue.length >= this.maxQueueSize) {
      if (this.debug) {
        console.warn(`[Datalyr] Queue full (${this.maxQueueSize}), dropping oldest event`);
      }
      this.queue.shift();
    }
    this.queue.push(event);
    if (this.debug) {
      console.log("[Datalyr] Event queued:", event.event);
    }
    if (this.queue.length >= this.flushAt) {
      this.flush().catch((err) => {
        if (this.debug) {
          console.error("[Datalyr] Auto-flush error:", err);
        }
      });
    }
  }
  async flush() {
    if (this.isFlushing || this.queue.length === 0) {
      return;
    }
    this.isFlushing = true;
    try {
      const events = [...this.queue];
      this.queue = [];
      if (this.debug) {
        console.log(`[Datalyr] Flushing ${events.length} events`);
      }
      const batchSize = 10;
      const errors = [];
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        const promises = batch.map(
          (event) => this.sendEvent(event).catch((err) => {
            errors.push(err);
            this.queue.unshift(event);
          })
        );
        await Promise.allSettled(promises);
      }
      if (errors.length > 0 && this.debug) {
        console.error(`[Datalyr] ${errors.length} events failed to send`);
      }
    } finally {
      this.isFlushing = false;
    }
  }
  async sendEvent(event, retryCount = 0) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      const response = await fetch(this.host, {
        method: "POST",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        let errorText = "";
        try {
          errorText = await response.text();
        } catch {
        }
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client error: ${response.status} ${response.statusText} - ${errorText}`);
        }
        throw new Error(`Server error: ${response.status} ${response.statusText} - ${errorText}`);
      }
      if (this.debug) {
        try {
          const result = await response.json();
          console.log("[Datalyr] Event sent successfully:", result);
        } catch {
          console.log("[Datalyr] Event sent successfully");
        }
      }
    } catch (error) {
      if (error.message?.startsWith("Client error:")) {
        if (this.debug) {
          console.error("[Datalyr] Permanent error, not retrying:", error.message);
        }
        throw error;
      }
      if (retryCount < this.retryLimit) {
        if (this.debug) {
          console.log(`[Datalyr] Retrying event (attempt ${retryCount + 1}/${this.retryLimit})`);
        }
        const backoffMs = Math.min(Math.pow(2, retryCount) * 1e3, 1e4);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.sendEvent(event, retryCount + 1);
      }
      throw error;
    }
  }
  startFlushTimer() {
    this.timer = setInterval(() => {
      if (!this.isClosing) {
        this.flush().catch((err) => {
          if (this.debug) {
            console.error("[Datalyr] Timer flush error:", err);
          }
        });
      }
    }, this.flushInterval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }
  generateAnonymousId() {
    return "anon_" + Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
  // Cleanup
  async close() {
    this.isClosing = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    const flushPromise = this.flush();
    const timeoutPromise = new Promise(
      (resolve) => setTimeout(() => resolve(), 5e3)
    );
    await Promise.race([flushPromise, timeoutPromise]);
    if (this.debug && this.queue.length > 0) {
      console.warn(`[Datalyr] Closing with ${this.queue.length} events still queued`);
    }
  }
};
var index_default = Datalyr;
export {
  Datalyr,
  index_default as default
};
