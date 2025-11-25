import React, { useState, useEffect } from 'react';
import { 
  Wifi, Activity, Cpu, Users, TrendingUp, AlertCircle, CheckCircle, 
  RefreshCw, Network, Zap, Download, Upload, Clock,
  List, Gauge, Eye, ArrowUpDown, BarChart3
} from 'lucide-react';
import { 
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';

const API_BASE_URL = '/api';

const MikroTikDashboard = () => {
  const [routers, setRouters] = useState([]);
  const [selectedRouter, setSelectedRouter] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [historicalData, setHistoricalData] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [queueData, setQueueData] = useState(null);
  const [bandwidthData, setBandwidthData] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Load selected router from localStorage on component mount
  useEffect(() => {
    const savedRouterId = localStorage.getItem('selectedRouterId');
    if (savedRouterId) {
      const routerId = parseInt(savedRouterId);
      // We'll set this after we load the routers
      console.log('Found saved router ID:', routerId);
    }
  }, []);

  // Save selected router to localStorage whenever it changes
  useEffect(() => {
    if (selectedRouter) {
      localStorage.setItem('selectedRouterId', selectedRouter.id.toString());
      console.log('Saved router ID to localStorage:', selectedRouter.id);
    }
  }, [selectedRouter]);

  const fetchRouterData = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${API_BASE_URL}/routers`);
      if (!response.ok) throw new Error('Failed to fetch');
      
      const data = await response.json();
      const mappedData = data.map(router => ({
        ...router,
        cpu: parseInt(router.cpu) || 0,
        memory: router.memoryUsage || 0,
        activeUsers: router.activeUsers || 0,
        totalQueues: router.totalQueues || 0
      }));
      
      setRouters(mappedData);
      setLastUpdate(new Date());
      
      const timestamp = new Date().toLocaleTimeString();
      setHistoricalData(prev => {
        const newData = [...prev, {
          time: timestamp,
          ...mappedData.reduce((acc, router) => ({
            ...acc,
            [`${router.name}_cpu`]: router.cpu,
            [`${router.name}_memory`]: router.memory
          }), {})
        }];
        return newData.slice(-20);
      });
      
      // FIX: Restore selected router from localStorage or use first online router
      const savedRouterId = localStorage.getItem('selectedRouterId');
      let routerToSelect = null;

      if (savedRouterId) {
        const savedId = parseInt(savedRouterId);
        routerToSelect = mappedData.find(r => r.id === savedId);
        console.log('Trying to restore router:', savedId, 'found:', routerToSelect);
      }

      // If saved router not found or no saved router, use first online router
      if (!routerToSelect) {
        routerToSelect = mappedData.find(r => r.status === 'online') || mappedData[0];
        console.log('Using default router:', routerToSelect?.id);
      }

      if (routerToSelect) {
        setSelectedRouter(routerToSelect);
        fetchRouterDetails(routerToSelect.id);
      }
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchRouterDetails = async (routerId) => {
    try {
      const [queueRes, bwRes] = await Promise.all([
        fetch(`${API_BASE_URL}/routers/${routerId}/queues`),
        fetch(`${API_BASE_URL}/routers/${routerId}/bandwidth`)
      ]);
      
      if (queueRes.ok) setQueueData(await queueRes.json());
      if (bwRes.ok) setBandwidthData(await bwRes.json());
    } catch (err) {
      console.error('Error fetching details:', err);
    }
  };

  useEffect(() => {
    fetchRouterData();
    const interval = setInterval(fetchRouterData, 10000);
    return () => clearInterval(interval);
  }, []);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

  const GradientCard = ({ children, className = '' }) => (
    <div className={`bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition-all ${className}`}>
      {children}
    </div>
  );

  const MetricCard = ({ icon: Icon, title, value, unit, color, subtitle }) => (
    <GradientCard>
      <div className="flex items-center space-x-2 mb-2">
        <Icon className={`text-${color}-500`} size={24} />
        <h3 className="text-sm font-medium text-gray-600">{title}</h3>
      </div>
      <div className="flex items-baseline space-x-2">
        <span className="text-3xl font-bold text-gray-900">{value}</span>
        {unit && <span className="text-lg text-gray-500">{unit}</span>}
      </div>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </GradientCard>
  );

  const RouterStatusCard = ({ router, isSelected, onClick }) => {
    const isOnline = router.status === 'online';
    const statusColor = isOnline ? 'green' : 'red';

    return (
      <div
        onClick={onClick}
        className={`bg-gradient-to-br ${isOnline ? 'from-white to-blue-50' : 'from-white to-red-50'} 
          rounded-xl shadow-lg p-5 cursor-pointer transition-all hover:shadow-xl hover:-translate-y-1 
          ${isSelected ? 'ring-4 ring-blue-500' : ''}`}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className={`p-2 bg-${statusColor}-100 rounded-lg`}>
              <Wifi className={`text-${statusColor}-600`} size={24} />
            </div>
            <div>
              <h3 className="font-bold text-gray-900">{router.name}</h3>
              <p className="text-xs text-gray-500">{router.version || 'MikroTik'}</p>
            </div>
          </div>
          {isOnline ? <CheckCircle className="text-green-500" size={24} /> : 
                      <AlertCircle className="text-red-500" size={24} />}
        </div>

        {isOnline ? (
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">CPU</span>
              <span className="font-bold">{router.cpu}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="h-2 rounded-full bg-blue-500 transition-all" 
                   style={{ width: `${router.cpu}%` }} />
            </div>
            
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Memory</span>
              <span className="font-bold">{router.memory}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="h-2 rounded-full bg-green-500 transition-all" 
                   style={{ width: `${router.memory}%` }} />
            </div>

            <div className="pt-2 border-t grid grid-cols-2 gap-2 text-xs text-gray-600">
              <span className="flex items-center">
                <Users size={14} className="mr-1" /> {router.activeUsers || 0} Users
              </span>
              <span className="flex items-center">
                <List size={14} className="mr-1" /> {router.totalQueues || 0} Queues
              </span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4">
            <AlertCircle className="mx-auto text-red-500 mb-2" size={32} />
            <p className="text-sm text-red-600 font-semibold">Offline</p>
          </div>
        )}
      </div>
    );
  };

  const QueueCard = ({ queue }) => (
    <div className="bg-white rounded-lg border p-4 hover:shadow-md transition-all">
      <div className="flex justify-between items-start mb-3">
        <div className="flex-1">
          <p className="font-semibold text-gray-900 truncate">{queue.name}</p>
          <p className="text-xs text-gray-500 truncate">{queue.target}</p>
        </div>
        <div className={`w-3 h-3 rounded-full ${queue.disabled ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`} />
      </div>
      
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-blue-50 rounded-lg p-2">
          <div className="flex items-center text-blue-600 mb-1">
            <Upload size={12} className="mr-1" />
            <span className="text-xs">Up</span>
          </div>
          <p className="font-bold text-xs">{queue.maxLimitUp}</p>
          <p className="text-xs text-gray-500">{queue.bytesUpFormatted}</p>
        </div>
        <div className="bg-green-50 rounded-lg p-2">
          <div className="flex items-center text-green-600 mb-1">
            <Download size={12} className="mr-1" />
            <span className="text-xs">Down</span>
          </div>
          <p className="font-bold text-xs">{queue.maxLimitDown}</p>
          <p className="text-xs text-gray-500">{queue.bytesDownFormatted}</p>
        </div>
      </div>
    </div>
  );

  const BandwidthCard = ({ iface }) => (
    <div className="bg-white rounded-lg border p-4 hover:shadow-md transition-all">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
          <p className="font-semibold text-gray-900">{iface.name}</p>
        </div>
        <Network className="text-gray-400" size={18} />
      </div>
      
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-blue-50 rounded-lg p-2">
          <div className="flex items-center text-blue-600 mb-1">
            <Upload size={12} className="mr-1" />
            <span className="text-xs">TX</span>
          </div>
          <p className="font-bold text-xs">{iface.txRateFormatted}</p>
        </div>
        <div className="bg-green-50 rounded-lg p-2">
          <div className="flex items-center text-green-600 mb-1">
            <Download size={12} className="mr-1" />
            <span className="text-xs">RX</span>
          </div>
          <p className="font-bold text-xs">{iface.rxRateFormatted}</p>
        </div>
      </div>
    </div>
  );

  const TabButton = ({ id, label, icon: Icon }) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`flex items-center space-x-2 px-4 py-2 rounded-lg font-medium transition-all ${
        activeTab === id ? 'bg-blue-600 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-50'
      }`}
    >
      <Icon size={18} />
      <span>{label}</span>
    </button>
  );

  if (error && routers.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center p-6">
        <GradientCard className="max-w-md text-center">
          <AlertCircle className="mx-auto text-red-500 mb-4" size={64} />
          <h2 className="text-2xl font-bold mb-2">Connection Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button onClick={fetchRouterData} className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Retry
          </button>
        </GradientCard>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 text-white shadow-xl">
        <div className="container mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-4xl font-bold mb-2">MikroTik Dashboard</h1>
              <p className="text-blue-100">Professional Multi-Router Monitoring</p>
            </div>
            <div className="flex items-center space-x-4">
              {lastUpdate && (
                <div className="text-right text-sm">
                  <p className="text-blue-100">Last Update</p>
                  <p className="font-semibold">{lastUpdate.toLocaleTimeString()}</p>
                </div>
              )}
              <button
                onClick={fetchRouterData}
                disabled={loading}
                className="flex items-center space-x-2 px-6 py-3 bg-white text-blue-600 rounded-lg hover:bg-blue-50 disabled:opacity-50 shadow-lg"
              >
                <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
                <span className="font-semibold">Refresh</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-6 py-8">
        {/* Router Cards */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Router Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {routers.map(router => (
              <RouterStatusCard
                key={router.id}
                router={router}
                isSelected={selectedRouter?.id === router.id}
                onClick={() => {
                  setSelectedRouter(router);
                  fetchRouterDetails(router.id);
                }}
              />
            ))}
          </div>
        </div>

        {/* Performance Trends */}
        {historicalData.length > 1 && (
          <GradientCard className="mb-8">
            <h3 className="text-xl font-bold mb-6">Performance Trends</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h4 className="text-sm font-semibold text-gray-600 mb-3">CPU Usage</h4>
                <ResponsiveContainer width="100%" height={250}>
                  <AreaChart data={historicalData}>
                    <defs>
                      {routers.map((r, i) => (
                        <linearGradient key={i} id={`color${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={COLORS[i]} stopOpacity={0.8}/>
                          <stop offset="95%" stopColor={COLORS[i]} stopOpacity={0}/>
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" style={{ fontSize: 12 }} />
                    <YAxis style={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    {routers.map((r, i) => (
                      <Area key={i} type="monotone" dataKey={`${r.name}_cpu`} 
                            stroke={COLORS[i]} fill={`url(#color${i})`} name={r.name} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-gray-600 mb-3">Memory Usage</h4>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={historicalData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" style={{ fontSize: 12 }} />
                    <YAxis style={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    {routers.map((r, i) => (
                      <Line key={i} type="monotone" dataKey={`${r.name}_memory`} 
                            stroke={COLORS[i]} strokeWidth={2} name={r.name} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </GradientCard>
        )}

        {/* Detailed Metrics */}
        {selectedRouter && selectedRouter.status === 'online' && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold">{selectedRouter.name} - Details</h2>
              <div className="flex space-x-2">
                <TabButton id="overview" label="Overview" icon={Eye} />
                <TabButton id="queues" label="Queues" icon={List} />
                <TabButton id="bandwidth" label="Bandwidth" icon={Gauge} />
              </div>
            </div>

            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <MetricCard icon={Cpu} title="CPU" value={selectedRouter.cpu} unit="%" color="blue" />
                  <MetricCard icon={Activity} title="Memory" value={selectedRouter.memory} unit="%" color="green" />
                  <MetricCard icon={Users} title="Users" value={selectedRouter.activeUsers || 0} color="purple" />
                  <MetricCard icon={List} title="Queues" value={queueData?.active || 0} 
                              subtitle={`${queueData?.total || 0} total`} color="orange" />
                </div>

                {bandwidthData && (
                  <GradientCard>
                    <h3 className="text-xl font-bold mb-4 flex items-center">
                      <Zap className="mr-2 text-yellow-500" size={24} />
                      Current Bandwidth
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                      <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-6">
                        <div className="flex items-center mb-2">
                          <Upload className="mr-2 text-blue-700" size={20} />
                          <span className="text-blue-700 font-semibold">Upload</span>
                        </div>
                        <p className="text-3xl font-bold text-blue-900">{bandwidthData.totalTxRateFormatted}</p>
                      </div>
                      <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-6">
                        <div className="flex items-center mb-2">
                          <Download className="mr-2 text-green-700" size={20} />
                          <span className="text-green-700 font-semibold">Download</span>
                        </div>
                        <p className="text-3xl font-bold text-green-900">{bandwidthData.totalRxRateFormatted}</p>
                      </div>
                    </div>
                  </GradientCard>
                )}
              </div>
            )}

            {/* Queues Tab */}
            {activeTab === 'queues' && queueData && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <MetricCard icon={List} title="Total" value={queueData.total} color="blue" />
                  <MetricCard icon={CheckCircle} title="Active" value={queueData.active} color="green" />
                  <MetricCard icon={AlertCircle} title="Disabled" value={queueData.disabled} color="red" />
                  <MetricCard icon={ArrowUpDown} title="Bandwidth" value={queueData.totalBandwidthDown} 
                              subtitle={`↑ ${queueData.totalBandwidthUp}`} color="purple" />
                </div>

                <GradientCard>
                  <h3 className="text-xl font-bold mb-6 flex items-center">
                    <List className="mr-2" size={24} />
                    Top Queues
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {queueData.queues?.map((q, i) => <QueueCard key={i} queue={q} />)}
                  </div>
                </GradientCard>
              </div>
            )}

            {/* Bandwidth Tab */}
            {activeTab === 'bandwidth' && bandwidthData && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <GradientCard>
                    <div className="flex items-center mb-4">
                      <Upload className="mr-2 text-blue-500" size={20} />
                      <h3 className="text-lg font-bold">Upload Rate</h3>
                    </div>
                    <p className="text-4xl font-bold text-blue-600">{bandwidthData.totalTxRateFormatted}</p>
                  </GradientCard>

                  <GradientCard>
                    <div className="flex items-center mb-4">
                      <Download className="mr-2 text-green-500" size={20} />
                      <h3 className="text-lg font-bold">Download Rate</h3>
                    </div>
                    <p className="text-4xl font-bold text-green-600">{bandwidthData.totalRxRateFormatted}</p>
                  </GradientCard>
                </div>

                <GradientCard>
                  <h3 className="text-xl font-bold mb-6 flex items-center">
                    <Gauge className="mr-2" size={24} />
                    Interface Bandwidth
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {bandwidthData.interfaces?.map((iface, i) => <BandwidthCard key={i} iface={iface} />)}
                  </div>
                </GradientCard>

                {bandwidthData.interfaces && bandwidthData.interfaces.length > 0 && (
                  <GradientCard>
                    <h3 className="text-xl font-bold mb-6">Bandwidth Comparison</h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={bandwidthData.interfaces}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" />
                        <YAxis label={{ value: 'Rate', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="txRate" fill="#3b82f6" name="Upload" />
                        <Bar dataKey="rxRate" fill="#10b981" name="Download" />
                      </BarChart>
                    </ResponsiveContainer>
                  </GradientCard>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MikroTikDashboard;
