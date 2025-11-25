const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const RouterOS = require('node-routeros').RouterOSAPI;
const fs = require('fs');
const path = require('path');

const app = express();

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }
});
app.use('/api/', limiter);

let routerConfigs = [];
try {
  const configPath = path.join(__dirname, 'config', 'routers.json');
  if (fs.existsSync(configPath)) {
    routerConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('Router configuration loaded');
  }
} catch (error) {
  console.error('Error loading config:', error);
}

async function connectToRouter(config) {
  const conn = new RouterOS({
    host: config.ip,
    user: config.username,
    password: config.password,
    port: config.port || 8728,
    timeout: 10
  });

  try {
    await conn.connect();
    return conn;
  } catch (err) {
    console.error(`Failed to connect to ${config.name}:`, err.message);
    return null;
  }
}

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
  const match = bandwidth.match(/(\d+)([KMG]?)/i);
  if (!match) return 0;
  
  const value = parseInt(match[1]);
  const unit = match[2].toUpperCase();
  
  const multipliers = { '': 1, 'K': 1000, 'M': 1000000, 'G': 1000000000 };
  return value * (multipliers[unit] || 1);
}

async function getRouterResources(conn) {
  try {
    const resources = await conn.write('/system/resource/print');
    const health = await conn.write('/system/health/print').catch(() => []);
    
    const totalMem = parseInt(resources[0]?.['total-memory']) || 0;
    const freeMem = parseInt(resources[0]?.['free-memory']) || 0;
    const usedMem = totalMem - freeMem;
    
    return {
      cpu: parseInt(resources[0]?.['cpu-load']) || 0,
      cpuLoad: resources[0]?.['cpu-load'] || '0',
      memoryTotal: totalMem,
      memoryFree: freeMem,
      memoryUsed: usedMem,
      memoryUsage: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      uptime: resources[0]?.uptime || '0s',
      version: resources[0]?.version || 'unknown',
      board: resources[0]?.['board-name'] || 'unknown',
      temperature: health[0]?.temperature || null,
      voltage: health[0]?.voltage || null
    };
  } catch (err) {
    console.error('Error getting resources:', err.message);
    return null;
  }
}

async function getActiveUsers(conn) {
  try {
    const interfaces = await conn.write('/interface/print');
    
    let pppoeCount = 0;
    if (Array.isArray(interfaces)) {
      pppoeCount = interfaces.filter(iface => 
        iface.type === 'pppoe-in' && iface.running === 'true'
      ).length;
    }

    return {
      dhcp: 0,
      hotspot: 0,
      pppoe: pppoeCount,
      total: pppoeCount
    };
  } catch (err) {
    console.error('Error getting active users:', err.message);
    return { dhcp: 0, hotspot: 0, pppoe: 0, total: 0 };
  }
}

async function getInterfaceStats(conn) {
  try {
    const interfaces = await conn.write('/interface/print');
    
    let totalRx = 0;
    let totalTx = 0;
    const interfaceList = [];
    
    if (Array.isArray(interfaces)) {
      for (const iface of interfaces) {
        if (iface.disabled === 'true') continue;
        
        const rxBytes = parseInt(iface['rx-byte']) || 0;
        const txBytes = parseInt(iface['tx-byte']) || 0;
        
        totalRx += rxBytes;
        totalTx += txBytes;
        
        interfaceList.push({
          name: iface.name,
          type: iface.type,
          rxBytes: rxBytes,
          txBytes: txBytes,
          rxFormatted: formatBytes(rxBytes),
          txFormatted: formatBytes(txBytes),
          running: iface.running === 'true',
          disabled: iface.disabled === 'true'
        });
      }
    }
    
    return {
      totalRx,
      totalTx,
      totalRxFormatted: formatBytes(totalRx),
      totalTxFormatted: formatBytes(totalTx),
      interfaces: interfaceList
    };
  } catch (err) {
    console.error('Error getting interface stats:', err.message);
    return {
      totalRx: 0,
      totalTx: 0,
      totalRxFormatted: '0 B',
      totalTxFormatted: '0 B',
      interfaces: []
    };
  }
}

// ========================================
// GET QUEUE STATISTICS
// ========================================
async function getQueueStats(conn) {
  try {
    const queues = await conn.write('/queue/simple/print');
    
    let totalQueues = 0;
    let activeQueues = 0;
    let totalBandwidthUp = 0;
    let totalBandwidthDown = 0;
    const queueList = [];
    
    if (Array.isArray(queues)) {
      totalQueues = queues.length;
      
      for (const queue of queues) {
        const isActive = queue.disabled !== 'true';
        if (isActive) activeQueues++;
        
        // Parse max-limit (format: "10M/5M")
        const maxLimit = queue['max-limit'] || '0/0';
        const [upLimit, downLimit] = maxLimit.split('/');
        
        const upBps = parseBandwidth(upLimit);
        const downBps = parseBandwidth(downLimit);
        
        totalBandwidthUp += upBps;
        totalBandwidthDown += downBps;
        
        // Parse current bytes
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
    
    return {
      total: totalQueues,
      active: activeQueues,
      disabled: totalQueues - activeQueues,
      totalBandwidthUp: formatBitsPerSecond(totalBandwidthUp),
      totalBandwidthDown: formatBitsPerSecond(totalBandwidthDown),
      queues: queueList.slice(0, 10)
    };
  } catch (err) {
    console.error('Error getting queue stats:', err.message);
    return { 
      total: 0, 
      active: 0, 
      disabled: 0,
      totalBandwidthUp: '0 bps',
      totalBandwidthDown: '0 bps',
      queues: [] 
    };
  }
}

// ========================================
// IMPROVED BANDWIDTH CALCULATION (Based on Python logic)
// ========================================
const trafficHistory = new Map();

function calculateRates(routerId, interfaceName, currentRx, currentTx) {
    const currentTime = Date.now();
    const key = `${routerId}_${interfaceName}`;
    
    if (!trafficHistory.has(key)) {
        trafficHistory.set(key, {
            lastRx: currentRx,
            lastTx: currentTx,
            lastTime: currentTime
        });
        return { rxRate: 0, txRate: 0 };
    }
    
    const history = trafficHistory.get(key);
    const timeDiff = (currentTime - history.lastTime) / 1000;
    
    if (timeDiff >= 2) {
        // Handle counter reset (like Python version)
        const rxDiff = currentRx >= history.lastRx ? (currentRx - history.lastRx) : currentRx;
        const txDiff = currentTx >= history.lastTx ? (currentTx - history.lastTx) : currentTx;
        
        const rxRate = Math.max(0, Math.round((rxDiff * 8) / timeDiff));
        const txRate = Math.max(0, Math.round((txDiff * 8) / timeDiff));
        
        trafficHistory.set(key, {
            lastRx: currentRx,
            lastTx: currentTx,
            lastTime: currentTime
        });
        
        return { rxRate, txRate };
    } else {
        return { rxRate: 0, txRate: 0 };
    }
}

async function getBandwidthRates(conn, routerId) {
    try {
        console.log(`Calculating bandwidth rates for router ${routerId}...`);
        
        const bandwidthList = [];
        let totalRxRate = 0;
        let totalTxRate = 0;

        try {
            const interfaces = await conn.write('/interface/print');
            
            if (Array.isArray(interfaces)) {
                let interfaceCount = 0;
                
                for (const iface of interfaces) {
                    const ifaceName = iface.name;
                    const ifaceType = iface.type;
                    
                    // Filter important interfaces (similar to Python logic)
                    if (!ifaceName.startsWith('ether') && 
                        !ifaceName.startsWith('vlan') && 
                        !ifaceName.startsWith('bridge') && 
                        !ifaceName.startsWith('pppoe') &&
                        !['ether', 'vlan', 'bridge', 'ppp-out'].includes(ifaceType)) {
                        continue;
                    }
                    
                    if (iface.disabled === 'true') continue;
                    
                    const currentRx = parseInt(iface['rx-byte']) || 0;
                    const currentTx = parseInt(iface['tx-byte']) || 0;
                    
                    const { rxRate, txRate } = calculateRates(routerId, ifaceName, currentRx, currentTx);
                    
                    // Only include interfaces with significant traffic
                    if (rxRate > 1000 || txRate > 1000) {
                        bandwidthList.push({
                            name: ifaceName,
                            type: ifaceType,
                            rxRate: rxRate,
                            txRate: txRate,
                            rxRateFormatted: formatBitsPerSecond(rxRate),
                            txRateFormatted: formatBitsPerSecond(txRate),
                            rxBytes: currentRx,
                            txBytes: currentTx,
                            running: iface.running === 'true'
                        });
                        
                        // Use ether1 as primary for total bandwidth
                        if (ifaceName === 'ether1') {
                            totalRxRate = rxRate;
                            totalTxRate = txRate;
                        }
                        
                        interfaceCount++;
                        if (interfaceCount >= 12) break;
                    }
                }
            }
            
            console.log(`Calculated rates for ${bandwidthList.length} interfaces`);
            
        } catch (err) {
            console.log('Error in bandwidth calculation:', err.message);
        }

        // If no bandwidth data, return empty structure
        if (bandwidthList.length === 0) {
            console.log('No bandwidth data calculated yet');
            bandwidthList.push({
                name: 'ether1',
                type: 'ether',
                rxRate: 0,
                txRate: 0,
                rxRateFormatted: '0 bps',
                txRateFormatted: '0 bps',
                rxBytes: 0,
                txBytes: 0,
                running: true
            });
        }

        const result = {
            totalRxRate: totalRxRate,
            totalTxRate: totalTxRate,
            totalRxRateFormatted: formatBitsPerSecond(totalRxRate),
            totalTxRateFormatted: formatBitsPerSecond(totalTxRate),
            interfaces: bandwidthList.slice(0, 20)
        };
        
        console.log('Bandwidth result:', {
            total: `${result.totalRxRateFormatted} / ${result.totalTxRateFormatted}`,
            interfaceCount: result.interfaces.length
        });
        
        return result;
        
    } catch (err) {
        console.error('Error getting bandwidth rates:', err.message);
        return {
            totalRxRate: 0,
            totalTxRate: 0,
            totalRxRateFormatted: '0 bps',
            totalTxRateFormatted: '0 bps',
            interfaces: []
        };
    }
}

// ========================================
// HEALTH CHECK
// ========================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    routers: routerConfigs.length 
  });
});

// ========================================
// GET ALL ROUTERS OVERVIEW
// ========================================
app.get('/api/routers', async (req, res) => {
  try {
    const results = await Promise.all(
      routerConfigs.map(async (config) => {
        const conn = await connectToRouter(config);
        
        if (!conn) {
          return {
            id: config.id,
            name: config.name,
            ip: config.ip,
            status: 'offline',
            error: 'Connection timeout',
            cpu: 0,
            memoryUsage: 0,
            uptime: '0s',
            activeUsers: 0
          };
        }

        try {
          const resources = await getRouterResources(conn);
          const users = await getActiveUsers(conn);
          const queues = await getQueueStats(conn);
          const bandwidth = await getBandwidthRates(conn, config.id);
          await conn.close();

          return {
            id: config.id,
            name: config.name,
            ip: config.ip,
            status: resources ? 'online' : 'error',
            activeUsers: users.total,
            totalQueues: queues.total,
            activeQueues: queues.active,
            currentBandwidth: bandwidth.totalRxRateFormatted,
            ...(resources || {
              cpu: 0,
              memoryUsage: 0,
              uptime: '0s'
            })
          };
        } catch (err) {
          console.error(`Error processing ${config.name}:`, err.message);
          try { await conn.close(); } catch (e) {}
          return {
            id: config.id,
            name: config.name,
            ip: config.ip,
            status: 'error',
            error: err.message,
            cpu: 0,
            memoryUsage: 0,
            uptime: '0s',
            activeUsers: 0
          };
        }
      })
    );

    res.json(results);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// GET SINGLE ROUTER DETAILS
// ========================================
app.get('/api/routers/:id', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) {
      return res.status(404).json({ error: 'Router not found' });
    }

    const conn = await connectToRouter(config);
    if (!conn) {
      return res.json({
        id: config.id,
        name: config.name,
        status: 'offline',
        error: 'Connection failed'
      });
    }

    try {
      const resources = await getRouterResources(conn);
      const users = await getActiveUsers(conn);
      const interfaces = await getInterfaceStats(conn);
      const queues = await getQueueStats(conn);
      const bandwidth = await getBandwidthRates(conn, routerId);
      await conn.close();

      res.json({
        id: config.id,
        name: config.name,
        ip: config.ip,
        status: 'online',
        users,
        interfaces,
        queues,
        bandwidth,
        ...resources
      });
    } catch (err) {
      console.error('Error getting router details:', err.message);
      try { await conn.close(); } catch (e) {}
      res.status(500).json({ error: 'Error retrieving router details' });
    }
  } catch (error) {
    console.error('Router detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// GET ROUTER TRAFFIC STATS
// ========================================
app.get('/api/routers/:id/traffic', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) {
      return res.status(404).json({ error: 'Router not found' });
    }

    const conn = await connectToRouter(config);
    if (!conn) {
      return res.json({ error: 'Connection failed' });
    }

    try {
      const interfaces = await getInterfaceStats(conn);
      await conn.close();
      res.json(interfaces);
    } catch (err) {
      try { await conn.close(); } catch (e) {}
      res.status(500).json({ error: 'Error retrieving traffic stats' });
    }
  } catch (error) {
    console.error('Traffic stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// GET QUEUE STATS ENDPOINT
// ========================================
app.get('/api/routers/:id/queues', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) {
      return res.status(404).json({ error: 'Router not found' });
    }

    const conn = await connectToRouter(config);
    if (!conn) {
      return res.json({ error: 'Connection failed' });
    }

    try {
      const queueStats = await getQueueStats(conn);
      await conn.close();
      res.json(queueStats);
    } catch (err) {
      try { await conn.close(); } catch (e) {}
      res.status(500).json({ error: 'Error retrieving queue stats' });
    }
  } catch (error) {
    console.error('Queue stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================================
// GET BANDWIDTH REAL-TIME ENDPOINT
// ========================================
app.get('/api/routers/:id/bandwidth', async (req, res) => {
  try {
    const routerId = parseInt(req.params.id);
    const config = routerConfigs.find(r => r.id === routerId);

    if (!config) {
      return res.status(404).json({ error: 'Router not found' });
    }

    const conn = await connectToRouter(config);
    if (!conn) {
      return res.json({ error: 'Connection failed' });
    }

    try {
      const bandwidth = await getBandwidthRates(conn, routerId);
      await conn.close();
      res.json(bandwidth);
    } catch (err) {
      try { await conn.close(); } catch (e) {}
      res.status(500).json({ error: 'Error retrieving bandwidth stats' });
    }
  } catch (error) {
    console.error('Bandwidth stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MikroTik API Server running on port ${PORT}`);
});
