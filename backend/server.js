const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const connectionPool = require('./connectionPool');

const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], credentials: true }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // Increase limit
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true
});
app.use('/api/', limiter);

let routerConfigs = [];
try {
  const configPath = path.join(__dirname, 'config', 'routers.json');
  if (fs.existsSync(configPath)) {
    routerConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`✅ Loaded ${routerConfigs.length} router configurations`);
  }
} catch (error) {
  console.error('❌ Error loading config:', error.message);
}

// Utility functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatBitsPerSecond(bps) {
  if (bps === 0) return '0 bps';
  const k = 1000;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  const i = Math.floor(Math.log(bps) / Math.log(k));
  return parseFloat((bps / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function parseBandwidth(bandwidth) {
  if (!bandwidth) return 0;
  const match = bandwidth.match(/(\d+\.?\d*)([KMG]?)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = { '': 1, 'K': 1000, 'M': 1000000, 'G': 1000000000 };
  return value * (multipliers[unit] || 1);
}

// OPTIMIZED: Lightweight resource query
async function getRouterResources(conn, config) {
  const cached = connectionPool.getFromCache(config.id, 'resources');
  if (cached) return cached;

  try {
    const resources = await conn.write('/system/resource/print');
    
    if (!resources || resources.length === 0) {
      throw new Error('No resource data returned');
    }
    
    const totalMem = parseInt(resources[0]?.['total-memory']) || 0;
    const freeMem = parseInt(resources[0]?.['free-memory']) || 0;
    const usedMem = totalMem - freeMem;
    
    const result = {
      cpu: parseInt(resources[0]?.['cpu-load']) || 0,
      cpuLoad: resources[0]?.['cpu-load'] || '0',
      memoryTotal: totalMem,
      memoryFree: freeMem,
      memoryUsed: usedMem,
      memoryUsage: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      uptime: resources[0]?.uptime || '0s',
      version: resources[0]?.version || 'unknown',
      board: resources[0]?.['board-name'] || 'unknown'
    };

    connectionPool.setCache(config.id, 'resources', result);
    return result;
  } catch (err) {
    console.error(`❌ ${config.name} - Error getting resources:`, err.message);
    return null;
  }
}

// OPTIMIZED: Only count active PPPoE
async function getActiveUsers(conn, config) {
  try {
    // Use more specific query to reduce data transfer
    const pppoeInterfaces = await conn.write('/interface/print', [
      '?type=pppoe-in',
      '?running=true'
    ]);
    
    const pppoeCount = Array.isArray(pppoeInterfaces) ? pppoeInterfaces.length : 0;
    
    return { dhcp: 0, hotspot: 0, pppoe: pppoeCount, total: pppoeCount };
  } catch (err) {
    console.error(`❌ ${config.name} - Error getting active users:`, err.message);
    return { dhcp: 0, hotspot: 0, pppoe: 0, total: 0 };
  }
}

// OPTIMIZED: Lightweight queue count only
async function getQueueStatsLight(conn, config) {
  const cached = connectionPool.getFromCache(config.id, 'queues_light');
  if (cached) return cached;

  try {
    const queues = await conn.write('/queue/simple/print', ['=count-only=']);
    
    let total = 0;
    if (Array.isArray(queues) && queues.length > 0) {
      total = parseInt(queues[0]) || queues.length;
    }
    
    // Get only active count without fetching all data
    const activeQueues = await conn.write('/queue/simple/print', [
      '?disabled=false',
      '=count-only='
    ]);
    
    const active = Array.isArray(activeQueues) && activeQueues.length > 0 
      ? parseInt(activeQueues[0]) || activeQueues.length
      : total;

    const result = { total, active, disabled: total - active };
    connectionPool.setCache(config.id, 'queues_light', result);
    return result;
  } catch (err) {
    console.error(`❌ ${config.name} - Error getting queue stats:`, err.message);
    return { total: 0, active: 0, disabled: 0 };
  }
}

// FULL queue stats - only when requested
async function getQueueStatsFull(conn, config) {
  const cached = connectionPool.getFromCache(config.id, 'queues');
  if (cached) return cached;

  try {
    const queues = await conn.write('/queue/simple/print');
    
    let totalQueues = 0, activeQueues = 0;
    let totalBandwidthUp = 0, totalBandwidthDown = 0;
    const queueList = [];
    
    if (Array.isArray(queues)) {
      totalQueues = queues.length;
      
      // Only process first 20 for display
      const limitedQueues = queues.slice(0, 20);
      
      for (const queue of limitedQueues) {
        const isActive = queue.disabled !== 'true';
        if (isActive) activeQueues++;
        
        const maxLimit = queue['max-limit'] || '0/0';
        const [upLimit, downLimit] = maxLimit.split('/');
        const upBps = parseBandwidth(upLimit);
        const downBps = parseBandwidth(downLimit);
        
        totalBandwidthUp += upBps;
        totalBandwidthDown += downBps;
        
        const bytes = queue.bytes || '0/0';
        const [bytesUp, bytesDown] = bytes.split('/');
        
        queueList.push({
          name: queue.name,
          target: queue.target,
          maxLimitUp: formatBitsPerSecond(upBps),
          maxLimitDown: formatBitsPerSecond(downBps),
          bytesUp: parseInt(bytesUp) || 0,
          bytesDown: parseInt(bytesDown) || 0,
          bytesUpFormatted: formatBytes(parseInt(bytesUp) || 0),
          bytesDownFormatted: formatBytes(parseInt(bytesDown) || 0),
          disabled: queue.disabled === 'true',
          parent: queue.parent || 'none'
        });
      }
    }
    
    const result = {
      total: totalQueues,
      active: activeQueues,
      disabled: totalQueues - activeQueues,
      totalBandwidthUp: formatBitsPerSecond(totalBandwidthUp),
      totalBandwidthDown: formatBitsPerSecond(totalBandwidthDown),
      queues: queueList
    };

    connectionPool.setCache(config.id, 'queues', result);
    return result;
  } catch (err) {
    console.error(`❌ ${config.name} - Error getting full queue stats:`, err.message);
    return { total: 0, active: 0, disabled: 0, totalBandwidthUp: '0 bps', totalBandwidthDown: '0 bps', queues: [] };
  }
}

// Bandwidth calculation
const trafficHistory = new Map();

function calculateRates(routerId, interfaceName, currentRx, currentTx) {
  const currentTime = Date.now();
  const key = `${routerId}_${interfaceName}`;
  
  if (!trafficHistory.has(key)) {
    trafficHistory.set(key, { lastRx: currentRx, lastTx: currentTx, lastTime: currentTime });
    return { rxRate: 0, txRate: 0 };
  }
  
  const history = trafficHistory.get(key);
  const timeDiff = (currentTime - history.lastTime) / 1000;
  
  if (timeDiff >= 1.5) { // Reduce from 2 to 1.5 seconds for faster updates
    const rxDiff = currentRx >= history.lastRx ? (currentRx - history.lastRx) : currentRx;
    const txDiff = currentTx >= history.lastTx ? (currentTx - history.lastTx) : currentTx;
    const rxRate = Math.max(0, Math.round((rxDiff * 8) / timeDiff));
    const txRate = Math.max(0, Math.round((txDiff * 8) / timeDiff));
    
    trafficHistory.set(key, { lastRx: currentRx, lastTx: currentTx, lastTime: currentTime });
    return { rxRate, txRate };
  }
  
  // Return cached rates if too soon
  const cachedRxDiff = currentRx >= history.lastRx ? (currentRx - history.lastRx) : currentRx;
  const cachedTxDiff = currentTx >= history.lastTx ? (currentTx - history.lastTx) : currentTx;
  const cachedTimeDiff = timeDiff || 1;
  
  return {
    rxRate: Math.round((cachedRxDiff * 8) / cachedTimeDiff),
    txRate: Math.round((cachedTxDiff * 8) / cachedTimeDiff)
  };
}

async function getBandwidthRates(conn, config) {
  const cached = connectionPool.getFromCache(config.id, 'bandwidth');
  if (cached) return cached;

  try {
    const bandwidthList = [];
    let totalRxRate = 0, totalTxRate = 0;
    
    // OPTIMIZED: Only fetch running interfaces
    const interfaces = await conn.write('/interface/print', ['?running=true']);
    
    if (Array.isArray(interfaces)) {
      for (const iface of interfaces) {
        // Skip virtual interfaces for better performance
        if (iface.name.includes('ovpn') || iface.name.includes('l2tp')) continue;
        
        const isRelevant = iface.name.startsWith('ether') || 
                          iface.name.startsWith('vlan') || 
                          iface.name.startsWith('bridge') ||
                          iface.name.startsWith('pppoe') ||
                          ['ether', 'vlan', 'bridge', 'ppp-out', 'pppoe-out'].includes(iface.type);
        
        if (!isRelevant) continue;
        
        const currentRx = parseInt(iface['rx-byte']) || 0;
        const currentTx = parseInt(iface['tx-byte']) || 0;
        const { rxRate, txRate } = calculateRates(config.id, iface.name, currentRx, currentTx);
        
        bandwidthList.push({
          name: iface.name,
          type: iface.type,
          rxRate, txRate,
          rxRateFormatted: formatBitsPerSecond(rxRate),
          txRateFormatted: formatBitsPerSecond(txRate),
          rxBytes: currentRx,
          txBytes: currentTx,
          running: true
        });
        
        // Use primary WAN interface for total
        if (iface.name === 'ether1' || iface.name === 'pppoe') {
          totalRxRate = rxRate;
          totalTxRate = txRate;
        }
      }
    }

    bandwidthList.sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate));

    const result = {
      totalRxRate, totalTxRate,
      totalRxRateFormatted: formatBitsPerSecond(totalRxRate),
      totalTxRateFormatted: formatBitsPerSecond(totalTxRate),
      interfaces: bandwidthList.slice(0, 20)
    };

    connectionPool.setCache(config.id, 'bandwidth', result);
    return result;
  } catch (err) {
    console.error(`❌ ${config.name} - Error getting bandwidth:`, err.message);
    return { 
      totalRxRate: 0, totalTxRate: 0, 
      totalRxRateFormatted: '0 bps', 
      totalTxRateFormatted: '0 bps', 
      interfaces: [] 
    };
  }
}

// ========================================
// OPTIMIZED API ENDPOINTS
// ========================================

app.get('/api/health', (req, res) => {
  const stats = connectionPool.getStats();
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    routers: routerConfigs.length,
    ...stats
  });
});

// OPTIMIZED: Overview dengan lightweight queries
app.get('/api/routers', async (req, res) => {
  try {
    const results = await Promise.all(
      routerConfigs.map(async (config) => {
        const cached = connectionPool.getFromCache(config.id, 'overview');
        if (cached) return cached;

        const conn = await connectionPool.getConnection(config);
        
        if (!conn) {
          return {
            id: config.id, name: config.name, ip: config.ip,
            status: 'offline', error: 'Connection timeout',
            cpu: 0, memoryUsage: 0, uptime: '0s', activeUsers: 0,
            totalQueues: 0, activeQueues: 0, currentBandwidth: '0 bps'
          };
        }

        try {
          // Parallel execution dengan lightweight queries
          const [resources, users, queues] = await Promise.all([
            getRouterResources(conn, config),
            getActiveUsers(conn, config),
            getQueueStatsLight(conn, config)
          ]);
          
          await connectionPool.releaseConnection(config);

          const result = {
            id: config.id, name: config.name, ip: config.ip,
            status: resources ? 'online' : 'error',
            activeUsers: users.total,
            totalQueues: queues.total,
            activeQueues: queues.active,
            currentBandwidth: '0 bps', // Will be updated by separate bandwidth endpoint
            ...(resources || { cpu: 0, memoryUsage: 0, uptime: '0s' })
          };

          connectionPool.setCache(config.id, 'overview', result);
          return result;
        } catch (err) {
          console.error(`❌ ${config.name}:`, err.message);
          await connectionPool.closeConnection(config);
          return {
            id: config.id, name: config.name, ip: config.ip,
            status: 'error', error: err.message,
            cpu: 0, memoryUsage: 0, uptime: '0s', activeUsers: 0,
            totalQueues: 0, activeQueues: 0, currentBandwidth: '0 bps'
          };
        }
      })
    );

    res.json(results);
  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Separate lightweight endpoint for updating bandwidth in cards
app.get('/api/routers/bandwidth-summary', async (req, res) => {
  try {
    const results = await Promise.all(
      routerConfigs.map(async (config) => {
        const conn = await connectionPool.getConnection(config);
        if (!conn) return { id: config.id, bandwidth: '0 bps' };

        try {
          const bandwidth = await getBandwidthRates(conn, config);
          await connectionPool.releaseConnection(config);
          return { 
            id: config.id, 
            bandwidth: bandwidth.totalRxRateFormatted 
          };
        } catch (err) {
          return { id: config.id, bandwidth: '0 bps' };
        }
      })
    );
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/routers/:id', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) return res.status(404).json({ error: 'Router not found' });

    const conn = await connectionPool.getConnection(config);
    if (!conn) {
      return res.json({ id: config.id, name: config.name, status: 'offline', error: 'Connection failed' });
    }

    try {
      const [resources, users, queues, bandwidth] = await Promise.all([
        getRouterResources(conn, config),
        getActiveUsers(conn, config),
        getQueueStatsFull(conn, config),
        getBandwidthRates(conn, config)
      ]);
      
      await connectionPool.releaseConnection(config);

      res.json({
        id: config.id, name: config.name, ip: config.ip,
        status: 'online', users, queues, bandwidth, ...resources
      });
    } catch (err) {
      console.error(`❌ ${config.name} - Error:`, err.message);
      await connectionPool.closeConnection(config);
      res.status(500).json({ error: 'Error retrieving router details' });
    }
  } catch (error) {
    console.error('❌ Router detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/routers/:id/bandwidth', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) return res.status(404).json({ error: 'Router not found' });

    const conn = await connectionPool.getConnection(config);
    if (!conn) return res.json({ error: 'Connection failed' });

    try {
      const bandwidth = await getBandwidthRates(conn, config);
      await connectionPool.releaseConnection(config);
      res.json(bandwidth);
    } catch (err) {
      await connectionPool.closeConnection(config);
      res.status(500).json({ error: 'Error retrieving bandwidth stats' });
    }
  } catch (error) {
    console.error('❌ Bandwidth error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/routers/:id/queues', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) return res.status(404).json({ error: 'Router not found' });

    const conn = await connectionPool.getConnection(config);
    if (!conn) return res.json({ error: 'Connection failed' });

    try {
      const queueStats = await getQueueStatsFull(conn, config);
      await connectionPool.releaseConnection(config);
      res.json(queueStats);
    } catch (err) {
      await connectionPool.closeConnection(config);
      res.status(500).json({ error: 'Error retrieving queue stats' });
    }
  } catch (error) {
    console.error('❌ Queue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing connections...');
  await connectionPool.closeAll();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, closing connections...');
  await connectionPool.closeAll();
  process.exit(0);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🚀 MikroTik API Server (OPTIMIZED)      ║
║   📡 Port: ${PORT}                            ║
║   🔧 Routers: ${routerConfigs.length}                          ║
║   ⚡ Connection Pool: ACTIVE               ║
║   💾 Smart Caching: ENABLED                ║
╚════════════════════════════════════════════╝
  `);
});
