const RouterOS = require('node-routeros').RouterOSAPI;

class ConnectionPool {
  constructor() {
    this.pools = new Map();
    this.cacheData = new Map();
    
    // Dynamic cache timeout based on endpoint
    this.cacheTimeouts = {
      overview: 3000,      // 3 seconds - untuk overview cards
      bandwidth: 2000,     // 2 seconds - real-time bandwidth
      queues: 10000,       // 10 seconds - queues jarang berubah
      interfaces: 5000,    // 5 seconds - interface stats
      resources: 3000      // 3 seconds - CPU/Memory
    };
    
    setInterval(() => this.cleanup(), 60000); // Cleanup every minute
  }

  getCacheKey(routerId, endpoint) {
    return `${routerId}_${endpoint}`;
  }

  getFromCache(routerId, endpoint) {
    const key = this.getCacheKey(routerId, endpoint);
    const cached = this.cacheData.get(key);
    const timeout = this.cacheTimeouts[endpoint] || 5000;
    
    if (cached && Date.now() - cached.timestamp < timeout) {
      return cached.data;
    }
    
    return null;
  }

  setCache(routerId, endpoint, data) {
    const key = this.getCacheKey(routerId, endpoint);
    this.cacheData.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  async getConnection(config) {
    const poolKey = `${config.id}_${config.ip}`;
    
    if (this.pools.has(poolKey)) {
      const poolEntry = this.pools.get(poolKey);
      
      // Keep connections alive for 2 minutes
      if (Date.now() - poolEntry.lastUsed < 120000) {
        poolEntry.lastUsed = Date.now();
        poolEntry.useCount++;
        return poolEntry.connection;
      } else {
        try {
          await poolEntry.connection.close();
        } catch (e) {}
        this.pools.delete(poolKey);
      }
    }

    const conn = new RouterOS({
      host: config.ip,
      user: config.username,
      password: config.password,
      port: config.port || 8728,
      timeout: 15, // Increase timeout untuk router sibuk
      keepalive: true
    });

    try {
      await conn.connect();
      
      this.pools.set(poolKey, {
        connection: conn,
        lastUsed: Date.now(),
        useCount: 1,
        config: config
      });
      
      return conn;
    } catch (err) {
      console.error(`❌ Failed to connect to ${config.name}:`, err.message);
      return null;
    }
  }

  async releaseConnection(config) {
    const poolKey = `${config.id}_${config.ip}`;
    if (this.pools.has(poolKey)) {
      const poolEntry = this.pools.get(poolKey);
      poolEntry.lastUsed = Date.now();
    }
  }

  async closeConnection(config) {
    const poolKey = `${config.id}_${config.ip}`;
    if (this.pools.has(poolKey)) {
      try {
        await this.pools.get(poolKey).connection.close();
      } catch (e) {}
      this.pools.delete(poolKey);
    }
  }

  cleanup() {
    const now = Date.now();
    const expireTime = 300000; // 5 minutes
    
    for (const [key, poolEntry] of this.pools.entries()) {
      if (now - poolEntry.lastUsed > expireTime) {
        try {
          poolEntry.connection.close();
        } catch (e) {}
        this.pools.delete(key);
      }
    }
    
    // Clean old cache entries
    for (const [key, cached] of this.cacheData.entries()) {
      if (now - cached.timestamp > 30000) { // 30 seconds max
        this.cacheData.delete(key);
      }
    }
  }

  async closeAll() {
    for (const [key, poolEntry] of this.pools.entries()) {
      try {
        await poolEntry.connection.close();
      } catch (e) {}
    }
    this.pools.clear();
  }

  getStats() {
    return {
      activeConnections: this.pools.size,
      cachedEntries: this.cacheData.size
    };
  }
}

module.exports = new ConnectionPool();
