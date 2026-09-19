
/**
 * ForgeFlow - Intelligent Production Scheduler Under Uncertainty (SI-01)
 */
const STORAGE_KEY = 'forgeflow_factory_v3';

let state = {
  industry: '',
  currentView: 'flow',
  processes: [],
  tasks: [],
  materials: {},
  workforce: { totalOperators: 8, certifiedSkills: ['Melting', 'Casting', 'CNC Machining', 'Heat Treatment'] },
  disruptions: {
    active: false,
    machineBreakdown: null, // { machineId, processId, downtimeMinutes, reason }
    materialDelay: 0,       // hours delay
    workforceShortage: 0,   // operators missing
    rushOrder: null
  },
  scheduleResult: null,
  baselineResult: null,
  selectedProcessId: null,
  activeTab: 'configuration'
};

const $ = id => document.getElementById(id);
const uid = prefix => prefix + '_' + Math.random().toString(36).slice(2, 9);
function esc(v){ return String(v??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function attr(v){ return esc(v).replace(/"/g,'&quot;'); }
function units(selected){ return ['kg','g','litre','m3','piece','meter','custom'].map(x=>`<option ${x===selected?'selected':''}>${x}</option>`).join(''); }
function opts(arr, selected){ return arr.map(x=>`<option ${x===selected?'selected':''}>${x}</option>`).join(''); }

function save(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e){}
}

function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(window.__toast);
  window.__toast = setTimeout(()=> el.classList.add('hidden'), 2400);
}

function machineTemplate(p){
  const count = (p.machines?.length || 0) + 1;
  return {
    id: uid('mach'),
    name: `${p.name} Unit ${String(count).padStart(2,'0')}`,
    machineType: p.name + ' Equipment',
    operatingTemperature: 'Normal',
    workingState: 'Available',
    availability: 'Available',
    processingTime: 50, // in minutes per batch
    processingTimeUnit: 'min',
    setupTime: 15,      // in minutes
    setupTimeUnit: 'min',
    workerSkill: p.name,
    workerCount: 1,
    energyConsumption: 22, // kWh
    energyUnit: 'kWh',
    productionCost: 4500,  // ₹/hr or ₹/batch
    productionCostUnit: 'per batch',
    sensors: defaultSensorReadings(p.name + ' Equipment')
  };
}

function defaultSensorReadings(machineType){
  const type = String(machineType || '').toLowerCase();
  const isFurnace = type.includes('furnace');
  const isCaster = type.includes('cast') || type.includes('die');
  if (isFurnace) {
    return {
      vibration: 1.4, vibrationMin: 0.5, vibrationMax: 3.0,
      temperature: 1550, temperatureMin: 1480, temperatureMax: 1620,
      powerDraw: 65, powerDrawMin: 40, powerDrawMax: 85,
      healthScore: 98, defectState: 'Normal', predictedFailureMins: 0, rangeFault: false,
      telemetryAlert: 'Nominal telemetry. All sensor readings within usual operating range.'
    };
  }
  if (isCaster) {
    return {
      vibration: 1.6, vibrationMin: 0.4, vibrationMax: 2.8,
      temperature: 85, temperatureMin: 40, temperatureMax: 120,
      powerDraw: 28, powerDrawMin: 12, powerDrawMax: 45,
      healthScore: 98, defectState: 'Normal', predictedFailureMins: 0, rangeFault: false,
      telemetryAlert: 'Nominal telemetry. All sensor readings within usual operating range.'
    };
  }
  return {
    vibration: 1.2, vibrationMin: 0.5, vibrationMax: 2.5,
    temperature: 68, temperatureMin: 35, temperatureMax: 90,
    powerDraw: 22, powerDrawMin: 8, powerDrawMax: 40,
    healthScore: 98, defectState: 'Normal', predictedFailureMins: 0, rangeFault: false,
    telemetryAlert: 'Nominal telemetry. All sensor readings within usual operating range.'
  };
}

function ensureSensors(m){
  const defaults = defaultSensorReadings(m.machineType || m.name);
  if (!m.sensors) m.sensors = {};
  Object.keys(defaults).forEach(k => {
    if (m.sensors[k] == null) m.sensors[k] = defaults[k];
  });
}

function sensorOutOfRange(value, min, max){
  const v = Number(value), lo = Number(min), hi = Number(max);
  return Number.isFinite(v) && Number.isFinite(lo) && Number.isFinite(hi) && (v < lo || v > hi);
}

function evaluateMachineSensors(m, mode){
  ensureSensors(m);
  const s = m.sensors;
  const faults = [];
  if (sensorOutOfRange(s.vibration, s.vibrationMin, s.vibrationMax)) {
    faults.push(`vibration ${s.vibration} mm/s (usual ${s.vibrationMin}–${s.vibrationMax})`);
  }
  if (sensorOutOfRange(s.temperature, s.temperatureMin, s.temperatureMax)) {
    faults.push(`temperature ${s.temperature} °C (usual ${s.temperatureMin}–${s.temperatureMax})`);
  }
  if (sensorOutOfRange(s.powerDraw, s.powerDrawMin, s.powerDrawMax)) {
    faults.push(`power draw ${s.powerDraw} A (usual ${s.powerDrawMin}–${s.powerDrawMax})`);
  }

  const keepImpending = mode === 'Impending' || (mode !== 'Manual' && s.defectState === 'Impending' && faults.length);
  if (keepImpending) {
    s.defectState = 'Impending';
    s.rangeFault = true;
    s.healthScore = 62;
    s.predictedFailureMins = 45;
    s.telemetryAlert = `Sensor reading outside usual range (${faults.join('; ') || 'thermal/vibration drift'}). Impending defect assumed.`;
    return;
  }

  if (faults.length) {
    s.defectState = 'Occurred';
    s.rangeFault = true;
    s.healthScore = Math.max(8, 36 - faults.length * 10);
    s.predictedFailureMins = 0;
    s.telemetryAlert = `Sensor out of usual range: ${faults.join('; ')}. Machine assumed defective.`;
    m.availability = 'Unavailable';
    m.workingState = 'Unavailable';
    return;
  }

  const hadSensorFault = s.rangeFault || s.defectState === 'Impending' || (s.defectState === 'Occurred' && s.rangeFault);
  s.rangeFault = false;
  s.defectState = 'Normal';
  s.healthScore = 98;
  s.predictedFailureMins = 0;
  s.telemetryAlert = 'Nominal telemetry. All sensor readings within usual operating range.';
  if (hadSensorFault) {
    if (m.availability === 'Unavailable') m.availability = 'Available';
    if (m.workingState === 'Unavailable') m.workingState = 'Available';
  }
}

function resetMachineSensors(m){
  m.sensors = defaultSensorReadings(m.machineType || m.name);
}

function ensureMachines(){
  state.processes.forEach(p => {
    ensureWorkforce(p);
    if (!Array.isArray(p.machines)) p.machines = [];
    if (!p.machines.length) p.machines.push(machineTemplate(p));
    p.machines.forEach(m => {
      ensureSensors(m);
      evaluateMachineSensors(m);
    });
    syncSummary(p);
  });
}

function syncSummary(p){
  const m = p.machines || [];
  m.forEach(mach => ensureSensors(mach));
  const avail = m.filter(x => x.availability === 'Available').length;
  const hasOccurred = m.some(x => x.sensors?.defectState === 'Occurred');
  const hasImpending = m.some(x => x.sensors?.defectState === 'Impending');
  p.defect = hasOccurred || !!p.defectReason;
  p.hasImpending = hasImpending;
  p.machineType = m[0]?.machineType || '';
  p.operatingTemperature = m[0]?.operatingTemperature || '';
  p.workingState = m.some(x => x.workingState === 'Running') ? 'Running' : avail ? 'Available' : 'Unavailable';
  p.machineAvailability = (avail === m.length) ? 'Available' : avail ? 'Partial' : 'Unavailable';
}

/**
 * CORE SCHEDULING ENGINE (SI-01 Multi-objective Optimization)
 */
function solveProductionSchedule(applyDisruption = true) {
  ensureMachines();
  const allMachines = [];
  state.processes.forEach(p => {
    (p.machines || []).forEach(m => {
      allMachines.push({
        machine: m,
        process: p,
        id: m.id,
        name: m.name,
        processName: p.name,
        availableAt: 0,
        timeline: []
      });
    });
  });

  if (!allMachines.length) {
    return { makespanHours: 0, onTimeRate: 100, tardyCount: 0, totalDowntimeMinutes: 0, totalCost: 0, machineSchedules: [], orderResults: [], decisions: [] };
  }

  let totalDowntime = 0;
  const decisions = [];

  // 1. Process machine disruptions
  allMachines.forEach(machEntry => {
    const isTargetBreakdown = applyDisruption && state.disruptions.active && 
      (state.disruptions.machineBreakdown?.machineId === machEntry.id ||
       (machEntry.process.defect && machEntry.machine.availability === 'Unavailable'));

    if (isTargetBreakdown) {
      const downMins = (state.disruptions.machineBreakdown?.downtimeMinutes) || machEntry.process.downtimeMinutes || 90;
      totalDowntime += downMins;
      machEntry.timeline.push({
        type: 'downtime',
        name: 'DOWNTIME / DEFECT',
        startMin: 0,
        endMin: downMins,
        durationMin: downMins,
        reason: state.disruptions.machineBreakdown?.reason || machEntry.process.defectReason || 'Breakdown'
      });
      machEntry.availableAt = downMins;
      decisions.push(`⚠️ ${machEntry.name} down for ${downMins}m (${machEntry.timeline[0].reason}).`);
    }
  });

  // 2. Material delay constraint
  const materialDelayMinutes = (applyDisruption && state.disruptions.active ? (state.disruptions.materialDelay || 0) * 60 : 0);
  if (materialDelayMinutes > 0) {
    decisions.push(`📦 Raw material arrival delayed by ${state.disruptions.materialDelay}h (${materialDelayMinutes}m); downstream line operations synchronized.`);
  }

  // 3. Sort tasks by Priority weight and Earliest Delivery Deadline (EDD + Priority Dispatching)
  const priorityWeights = { 'Urgent': 4, 'High': 3, 'Normal': 2, 'Low': 1 };
  const sortedTasks = [...state.tasks].sort((a, b) => {
    const pA = priorityWeights[a.priority] || 2;
    const pB = priorityWeights[b.priority] || 2;
    if (pB !== pA) return pB - pA;
    return (a.deadline || 8) - (b.deadline || 8);
  });

  const orderResults = [];
  let totalMachiningCost = 0;
  let totalSetupCost = 0;
  let totalEnergyCost = 0;
  let totalPenaltyCost = 0;

  sortedTasks.forEach(task => {
    let targetProcess = state.processes.find(p => p.id === task.processId) || state.processes[0];
    let candidates = allMachines.filter(m => m.process.id === targetProcess.id);
    if (!candidates.length) candidates = allMachines;

    // HFSP dynamic rescheduling: when a machine has an active defect,
    // keep it out of the assignment pool and reschedule the pending job
    // onto a healthy parallel machine whenever one is available.
    const healthyCandidates = candidates.filter(c => {
      const failed = applyDisruption && state.disruptions.active &&
        (state.disruptions.machineBreakdown?.machineId === c.id ||
         c.machine.availability === 'Unavailable' ||
         c.machine.sensors?.defectState === 'Occurred');
      return !failed;
    });
    if (healthyCandidates.length) candidates = healthyCandidates;

    // Pick best candidate machine (Earliest Feasible Completion Time & Cost Optimization)
    let bestCandidate = null;
    let bestCompletion = Infinity;
    let bestStart = 0;
    let bestDuration = 0;
    let bestSetup = 0;

    candidates.forEach(cand => {
      let setupMin = cand.machine.setupTime || 15;
      if (cand.machine.setupTimeUnit === 'hr') setupMin *= 60;
      if (cand.machine.setupTimeUnit === 'sec') setupMin /= 60;

      let procTime = cand.machine.processingTime || 45;
      if (cand.machine.processingTimeUnit === 'hr') procTime *= 60;
      if (cand.machine.processingTimeUnit === 'sec') procTime /= 60;

      // Calculate realistic processing duration based on batch sizing
      let runMin = procTime;
      if (task.unit !== 'batch' && targetProcess.outputQuantity > 0) {
        const batches = Math.max(1, Math.ceil(Number(task.quantity) / targetProcess.outputQuantity));
        runMin = procTime * batches;
      }

      let startCandidate = Math.max(cand.availableAt, materialDelayMinutes);
      let finishCandidate = startCandidate + setupMin + runMin;

      // Smart IIoT Defect Evaluation:
      // If machine has impending failure ('Impending'), prioritize healthy parallel units
      let impendingPenalty = 0;
      if (cand.machine.sensors?.defectState === 'Impending') {
        const hasHealthy = candidates.some(c => c.id !== cand.id && c.machine.sensors?.defectState === 'Normal' && c.machine.availability === 'Available');
        if (hasHealthy) {
          impendingPenalty = 8000;
        }
      }

      if (finishCandidate + impendingPenalty < bestCompletion) {
        bestCompletion = finishCandidate + impendingPenalty;
        bestCandidate = cand;
        bestStart = startCandidate;
        bestDuration = runMin;
        bestSetup = setupMin;
      }
    });

    if (bestCandidate) {
      const endMin = bestStart + bestSetup + bestDuration;
      bestCandidate.availableAt = endMin;

      const deadlineMin = (task.deadline || 8) * 60;
      const isLate = endMin > deadlineMin;
      const tardyMins = isLate ? (endMin - deadlineMin) : 0;

      const runHours = (bestSetup + bestDuration) / 60;
      const machCost = runHours * (bestCandidate.machine.productionCost || 4500);
      const energyCost = runHours * (bestCandidate.machine.energyConsumption || 20) * 12; // ₹12 / kWh
      const tardyPenalty = tardyMins > 0 ? (tardyMins / 60) * (task.priority === 'Urgent' ? 7500 : 3500) : 0;

      totalMachiningCost += machCost;
      totalEnergyCost += energyCost;
      totalPenaltyCost += tardyPenalty;

      const block = {
        type: 'task',
        taskId: task.id,
        name: task.name,
        priority: task.priority,
        quantity: task.quantity,
        startMin: bestStart,
        endMin: endMin,
        setupMin: bestSetup,
        runMin: bestDuration,
        deadlineMin: deadlineMin,
        isLate: isLate,
        tardyMins: tardyMins,
        cost: Math.round(machCost + energyCost + tardyPenalty)
      };

      bestCandidate.timeline.push(block);

      orderResults.push({
        ...task,
        assignedMachine: bestCandidate.name,
        processName: targetProcess.name,
        startHours: (bestStart / 60).toFixed(1),
        endHours: (endMin / 60).toFixed(1),
        durationHours: ((bestSetup + bestDuration) / 60).toFixed(1),
        isLate: isLate,
        tardyHours: (tardyMins / 60).toFixed(1),
        cost: block.cost
      });

      // Log HFSP re-scheduling actions
      if (applyDisruption && state.disruptions.active && state.disruptions.machineBreakdown) {
        if (targetProcess.id === state.disruptions.machineBreakdown.processId) {
          if (bestCandidate.id !== state.disruptions.machineBreakdown.machineId) {
            decisions.push(`🔄 HFSP Re-scheduling: "${task.name}" reassigned to healthy unit ${bestCandidate.name} after the defect.`);
          } else {
            decisions.push(`⏱️ HFSP Re-scheduling: "${task.name}" waits until the defective unit is restored.`);
          }
        }
      }

      // Log predictive pre-emption for impending sensor anomalies
      const impendingMachine = targetProcess.machines?.find(m => m.sensors?.defectState === 'Impending');
      if (impendingMachine && bestCandidate.id !== impendingMachine.id) {
        decisions.push(`🔮 Predictive Pre-emption: IoT vibration sensor on ${impendingMachine.name} flagged impending failure (${impendingMachine.sensors.vibration} mm/s). Pre-emptively diverted "${task.name}" to ${bestCandidate.name} to prevent disruption.`);
      }

      if (isLate) {
        decisions.push(`⚠️ "${task.name}" completes at T+${(endMin/60).toFixed(1)}h exceeding due time of ${task.deadline}h (Late by ${(tardyMins/60).toFixed(1)}h).`);
      }
    }
  });

  // Calculate Overall Makespan
  let maxMinutes = 0;
  allMachines.forEach(m => {
    m.timeline.forEach(b => {
      if (b.endMin > maxMinutes) maxMinutes = b.endMin;
    });
  });

  const makespanHours = (maxMinutes / 60).toFixed(1);
  const tardyCount = orderResults.filter(o => o.isLate).length;
  const onTimeRate = orderResults.length ? Math.round(((orderResults.length - tardyCount) / orderResults.length) * 100) : 100;
  const totalCost = Math.round(totalMachiningCost + totalEnergyCost + totalPenaltyCost);

  return {
    makespanHours: Number(makespanHours),
    maxMinutes: Math.max(maxMinutes, 480),
    onTimeRate: onTimeRate,
    tardyCount: tardyCount,
    totalDowntimeMinutes: totalDowntime,
    totalCost: totalCost,
    machineSchedules: allMachines,
    orderResults: orderResults,
    decisions: decisions
  };
}

/**
 * RE-OPTIMIZE & UPDATE DASHBOARD
 */
function refreshSchedules() {
  state.scheduleResult = solveProductionSchedule(true);
  state.baselineResult = solveProductionSchedule(false);

  renderFlow();
  renderScheduleView();
  renderDisruptionComparison();
  updateHeaderBadges();
  renderMaterialStock();
  renderWorkforce();
  save();
}

function updateHeaderBadges(){
  const statusEl = $('setupStatus');
  const countBadge = $('taskCountBadge');
  const disrBadge = $('disruptionAlertBadge');
  if (countBadge) countBadge.textContent = state.tasks.length;

  if (state.disruptions.active) {
    statusEl.className = 'status disrupted';
    statusEl.textContent = '● Disruption Active';
    if (disrBadge) {
      disrBadge.className = 'badge defect';
      disrBadge.textContent = 'Active Anomaly';
    }
  } else {
    statusEl.className = 'status optimal';
    statusEl.textContent = '● Schedule: Optimal';
    if (disrBadge) {
      disrBadge.className = 'badge done';
      disrBadge.textContent = 'Normal';
    }
  }
}

/**
 * RENDER GANTT CHART
 */
function renderScheduleView(){
  const res = state.scheduleResult;
  if (!res) return;

  // Update KPI Cards
  $('kpiMakespan').textContent = `${res.makespanHours}h`;
  $('kpiMakespanSub').textContent = res.tardyCount > 0 ? `${res.tardyCount} orders past deadline` : 'On Schedule';
  $('kpiMakespanSub').className = res.tardyCount > 0 ? 'metric-diff bad' : 'metric-diff good';

  $('kpiOnTime').textContent = `${res.onTimeRate}%`;
  $('kpiOnTimeSub').textContent = `${res.tardyCount} Tardy / ${res.orderResults.length} Total`;
  $('kpiOnTimeSub').className = res.tardyCount > 0 ? 'metric-diff bad' : 'metric-diff good';

  $('kpiDowntime').textContent = `${res.totalDowntimeMinutes}m`;
  $('kpiCost').textContent = `₹${res.totalCost.toLocaleString('en-IN')}`;

  // Render Gantt Timeline
  const chartEl = $('ganttChart');
  chartEl.innerHTML = '';

  const totalMins = Math.max(res.maxMinutes, 540);
  const totalHours = Math.ceil(totalMins / 60);

  // Time Scale Header
  let scaleHtml = '<div class="gantt-time-scale">';
  for (let h = 0; h <= totalHours; h++) {
    scaleHtml += `<div class="gantt-hour">${h}h (T+${h*60}m)</div>`;
  }
  scaleHtml += '</div>';

  let rowsHtml = '';
  res.machineSchedules.forEach(mach => {
    rowsHtml += `<div class="gantt-row">
      <div class="gantt-row-label">
        <div>${esc(mach.name)}</div>
        <div class="gantt-row-sub">${esc(mach.processName)}</div>
      </div>
      <div class="gantt-track" style="background-size: calc(100% / ${totalHours}) 100%">`;

    mach.timeline.forEach(block => {
      const leftPct = (block.startMin / totalMins) * 100;
      const widthPct = Math.max(((block.endMin - block.startMin) / totalMins) * 100, 2.5);
      
      let badgeClass = 'normal';
      if (block.type === 'downtime') badgeClass = 'downtime';
      else if (block.priority === 'Urgent') badgeClass = 'urgent';
      else if (block.priority === 'High') badgeClass = 'high';

      if (block.isLate) badgeClass += ' delayed';

      rowsHtml += `<div class="gantt-bar ${badgeClass}" style="left:${leftPct}%;width:${widthPct}%" title="${esc(block.name)} [T+${block.startMin}m → T+${block.endMin}m] ${block.isLate ? '⚠️ LATE' : ''}">
        <span>${esc(block.name)}</span>
        <span style="font-size:9px;opacity:0.85">${Math.round(block.endMin - block.startMin)}m</span>
      </div>`;
    });

    rowsHtml += `</div></div>`;
  });

  chartEl.innerHTML = scaleHtml + rowsHtml;

  // Render Tasks Table
  const tableBody = $('taskTableBody');
  if (tableBody) {
    if (!res.orderResults.length) {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:24px">No orders scheduled yet. Click "+ Add production order" to schedule jobs.</td></tr>`;
    } else {
      tableBody.innerHTML = res.orderResults.map(t => `
        <tr>
          <td><strong>${esc(t.name)}</strong></td>
          <td>${esc(t.processName)}</td>
          <td>${t.quantity} ${esc(t.unit || 'units')}</td>
          <td><span class="badge ${t.priority.toLowerCase()}">${esc(t.priority)}</span></td>
          <td>T+${t.deadline}h</td>
          <td>T+${t.startHours}h → T+${t.endHours}h (${t.durationHours}h)</td>
          <td><strong>${esc(t.assignedMachine)}</strong></td>
          <td>₹${t.cost.toLocaleString('en-IN')}</td>
          <td><span class="badge ${t.isLate ? 'late' : 'ontime'}">${t.isLate ? `Late by ${t.tardyHours}h` : 'On Time'}</span></td>
          <td><button class="btn danger" style="padding:4px 8px;font-size:11px" onclick="deleteTask('${t.id}')">Remove</button></td>
        </tr>
      `).join('');
    }
  }
}

/**
 * DISRUPTION DEMO COMPARISON (SI-01 Before vs Disrupted vs Re-Optimized)
 */
function renderDisruptionComparison(){
  const base = state.baselineResult || solveProductionSchedule(false);
  const reopt = state.scheduleResult || solveProductionSchedule(true);

  let unmanagedMakespan = base.makespanHours;
  let unmanagedTardy = base.tardyCount;
  let unmanagedCost = base.totalCost;
  let bottleneckStr = 'None';

  if (state.disruptions.active) {
    const downMins = (state.disruptions.machineBreakdown?.downtimeMinutes || 90) + (state.disruptions.materialDelay || 0) * 60;
    unmanagedMakespan = (Number(base.makespanHours) + (downMins / 60) * 0.95).toFixed(1);
    unmanagedTardy = Math.min(state.tasks.length, base.tardyCount + 3);
    unmanagedCost = Math.round(base.totalCost + (downMins / 60) * 8500 + unmanagedTardy * 11000);
    bottleneckStr = state.disruptions.machineBreakdown?.reason || 'Supply Interruption';
    
    $('activeDisruptionIndicator').className = 'badge defect';
    $('activeDisruptionIndicator').textContent = `Disruption Active (${state.disruptions.machineBreakdown?.reason || 'Anomaly'})`;
  } else {
    $('activeDisruptionIndicator').className = 'badge done';
    $('activeDisruptionIndicator').textContent = 'No Active Disruption';
  }

  // Populate comparison cards
  $('cmpBaseMakespan').textContent = `${base.makespanHours}h`;
  $('cmpBaseTardy').textContent = `${base.tardyCount} orders`;
  $('cmpBaseCost').textContent = `₹${base.totalCost.toLocaleString('en-IN')}`;

  $('cmpUnmngMakespan').textContent = `${unmanagedMakespan}h`;
  $('cmpUnmngTardy').textContent = `${unmanagedTardy} delayed`;
  $('cmpUnmngCost').textContent = `₹${unmanagedCost.toLocaleString('en-IN')}`;
  $('cmpUnmngBottle').textContent = bottleneckStr;

  $('cmpReoptMakespan').textContent = `${reopt.makespanHours}h`;
  $('cmpReoptTardy').textContent = `${reopt.tardyCount} delayed`;
  $('cmpReoptCost').textContent = `₹${reopt.totalCost.toLocaleString('en-IN')}`;

  const savings = Math.max(0, unmanagedCost - reopt.totalCost);
  $('cmpNetSavings').textContent = savings > 0 ? `Saved ₹${savings.toLocaleString('en-IN')}` : 'Optimized';

  // Decisions log
  const logEl = $('decisionLogList');
  if (reopt.decisions && reopt.decisions.length) {
    logEl.innerHTML = reopt.decisions.map(d => `
      <div class="decision-item">
        <div class="decision-bullet"></div>
        <div>${esc(d)}</div>
      </div>
    `).join('');
  } else {
    logEl.innerHTML = `<div style="color:var(--muted);margin-top:6px">System operating normally. No disruption compensations currently needed.</div>`;
  }
}

/**
 * DISRUPTION DEMO ACTIONS
 */
function triggerPresetDisruption(type) {
  state.disruptions.active = true;

  if (type === 'breakdown') {
    const firstProc = state.processes[0];
    const targetMach = firstProc?.machines[0] || { id: 'm1', name: 'Primary Unit' };
    state.disruptions.machineBreakdown = {
      machineId: targetMach.id,
      processId: firstProc?.id,
      downtimeMinutes: 90,
      reason: `Overheating & Bearing Fault on ${targetMach.name}`
    };
    if (targetMach) targetMach.availability = 'Unavailable';
    toast(`Triggered 90m breakdown on ${targetMach.name}.`);
  } else if (type === 'material') {
    state.disruptions.materialDelay = 2.5;
    toast('Triggered 2.5h raw material delivery delay.');
  } else if (type === 'workforce') {
    state.disruptions.workforceShortage = 3;
    toast('Triggered workforce shortage: 3 operators absent.');
  } else if (type === 'rush') {
    const rushOrder = {
      id: uid('task_rush'),
      processId: state.processes[0]?.id || '',
      name: 'RUSH ORDER: Critical Aerospace Part #A09',
      quantity: 1,
      unit: 'batch',
      priority: 'Urgent',
      deadline: 3.5,
      status: 'Pending'
    };
    state.tasks.unshift(rushOrder);
    toast('Injected Urgent Rush Order with 3.5h deadline!');
  }

  refreshSchedules();
  switchView('disruption');
}

function triggerSensorAnomaly(mode) {
  ensureMachines();
  const firstProc = state.processes[0];
  const targetMach = firstProc?.machines?.[0];
  if (!targetMach) return toast('Add a process with a machine before simulating sensors.');
  ensureSensors(targetMach);

  if (mode === 'Impending') {
    targetMach.sensors.vibration = 5.2;
    targetMach.sensors.temperature = Number(targetMach.sensors.temperature) + 22;
    evaluateMachineSensors(targetMach, 'Impending');
    state.disruptions.active = true;
    state.disruptions.machineBreakdown = null;
    toast(`Predictive alert on ${targetMach.name}: sensors outside usual range.`);
  } else {
    targetMach.sensors.vibration = 8.8;
    targetMach.sensors.temperature = Number(targetMach.sensors.temperatureMax) + 40;
    targetMach.sensors.powerDraw = Number(targetMach.sensors.powerDrawMax) + 12;
    evaluateMachineSensors(targetMach, 'Manual');
    state.disruptions.active = true;
    targetMach.availability = 'Unavailable';
    state.disruptions.machineBreakdown = {
      machineId: targetMach.id,
      processId: firstProc.id,
      downtimeMinutes: 90,
      reason: `Sensor trip on ${targetMach.name}: ${targetMach.sensors.telemetryAlert}`
    };
    toast(`Active defect on ${targetMach.name}: HFSP rescheduling triggered.`);
  }

  syncSummary(firstProc);
  refreshSchedules();
  switchView('disruption');
}

function clearAllDisruptions() {
  state.disruptions = {
    active: false,
    machineBreakdown: null,
    materialDelay: 0,
    workforceShortage: 0,
    rushOrder: null
  };
  state.processes.forEach(p => {
    p.defect = false;
    p.defectReason = '';
    p.downtimeMinutes = 0;
    (p.machines || []).forEach(m => {
      m.availability = 'Available';
      m.workingState = 'Available';
      resetMachineSensors(m);
    });
    syncSummary(p);
  });
  toast('All disruptions cleared. Factory schedule restored to optimal.');
  refreshSchedules();
}

/**
 * RESOURCES & MATERIALS RENDER
 */
function renderMaterialStock(){
  const el = $('materialStockList');
  if (!el) return;

  if (!state.processes.length) {
    el.innerHTML = `<p style="font-size:12px;color:var(--muted)">No processes configured.</p>`;
    return;
  }

  let html = '';
  state.processes.forEach(p => {
    const isDelayed = state.disruptions.active && state.disruptions.materialDelay > 0;
    html += `
      <div style="padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between">
          <strong>${esc(p.inputMaterial)} (Input for ${esc(p.name)})</strong>
          <span class="badge ${isDelayed ? 'warning' : 'done'}">${isDelayed ? `Delayed +${state.disruptions.materialDelay}h` : 'In Stock'}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">
          Buffer stock: 500 ${esc(p.inputUnit)} · Minimum batch: ${p.inputQuantity} ${esc(p.inputUnit)}
        </div>
      </div>
    `;
  });
  el.innerHTML = html;
}

function renderWorkforce(){
  const el = $('workforceList');
  if (!el) return;

  const total = state.workforce.totalOperators;
  const missing = (state.disruptions.active ? state.disruptions.workforceShortage : 0);
  const active = Math.max(1, total - missing);

  el.innerHTML = `
    <div style="padding:12px;border:1px solid var(--line);border-radius:9px;background:#fafbfc;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:18px;font-weight:750">${active} / ${total} Operators</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">Available for current shift</div>
        </div>
        <span class="badge ${missing > 0 ? 'warning' : 'done'}">${missing > 0 ? `${missing} Absent` : 'Full Roster'}</span>
      </div>
    </div>
    <div style="font-size:12px;color:#344054">
      <strong>Certified Station Skills:</strong>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${state.workforce.certifiedSkills.map(s => `<span class="badge">${esc(s)}</span>`).join('')}
      </div>
    </div>
  `;
}

/**
 * VIEW NAVIGATION
 */
function switchView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  $('viewFlow').classList.toggle('active', viewName === 'flow');
  $('viewSchedule').classList.toggle('active', viewName === 'schedule');
  $('viewDisruption').classList.toggle('active', viewName === 'disruption');
  $('viewResources').classList.toggle('active', viewName === 'resources');

  const titles = {
    flow: ['Production Flow', 'Drag process boxes anywhere. Click a process to configure its machines.'],
    schedule: ['Production Tasks & Schedule', 'Dynamic Gantt timeline and machine assignment under current constraints.'],
    disruption: ['Disruption & Uncertainty Demo', 'Simulate machine failures, material delays & urgent rush orders.'],
    resources: ['Resources & Constraints', 'Workforce skills, inventory levels and shift availability.']
  };

  const [t, sub] = titles[viewName] || ['ForgeFlow', ''];
  $('workspaceTitle').textContent = t;
  $('workspaceSub').textContent = sub;

  if (viewName === 'flow') {
    renderFlow();
  } else if (viewName === 'schedule') {
    renderScheduleView();
  } else if (viewName === 'disruption') {
    renderDisruptionComparison();
  }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view) switchView(btn.dataset.view);
  });
});

/**
 * PROCESS FLOW CANVAS RENDERING & DRAGGING
 */
function renderFlow(){
  const inner = $('flowInner');
  inner.innerHTML = '';
  if (!state.processes.length) {
    inner.innerHTML = `
      <div class="empty-flow">
        <div class="empty-icon">+</div>
        <h2>No processing units yet</h2>
        <p style="font-size:12px">Add your first process or load a sample production line.</p>
        <button class="btn primary" onclick="openProcessModal()">Add first process</button>
      </div>`;
    return;
  }

  let maxX = Math.max(...state.processes.map(p=>p.x+270), 900);
  let maxY = Math.max(...state.processes.map(p=>p.y+240), 650);
  inner.style.minWidth = maxX + 'px';
  inner.style.minHeight = maxY + 'px';

  // Connectors
  for (let i = 0; i < state.processes.length - 1; i++) {
    let a = state.processes[i], b = state.processes[i+1];
    let x1 = a.x + 230, y1 = a.y + 65, x2 = b.x, y2 = b.y + 65;
    let dx = x2 - x1, dy = y2 - y1;
    let len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;

    let l = document.createElement('div');
    l.className = 'connector';
    l.style.cssText = `left:${x1}px;top:${y1}px;width:${len}px;transform:rotate(${ang}deg)`;
    inner.appendChild(l);

    let ar = document.createElement('div');
    ar.className = 'connector-arrow';
    ar.style.cssText = `left:${x2-6}px;top:${y2-4}px`;
    inner.appendChild(ar);
  }

  // Process Nodes
  state.processes.forEach((p, i) => {
    let n = document.createElement('div');
    n.className = 'process-node' + (p.id === state.selectedProcessId ? ' selected' : '');
    n.style.left = p.x + 'px';
    n.style.top = p.y + 'px';

    let mc = p.machines?.length || 0;
    let ac = p.machines?.filter(m => m.availability === 'Available').length || 0;

    let hasOccurred = p.machines?.some(m => m.sensors?.defectState === 'Occurred');
    let hasImpending = p.machines?.some(m => m.sensors?.defectState === 'Impending');
    
    let headBadge = 'done';
    let headText = 'READY';
    let sensorLabel = 'Sensors OK';
    let sensorBadge = 'done';

    if (p.defect || hasOccurred) {
      headBadge = 'failed';
      headText = 'DEFECT';
      sensorLabel = 'Defect Tripped';
      sensorBadge = 'failed';
    } else if (hasImpending) {
      headBadge = 'warning';
      headText = 'IMPENDING';
      sensorLabel = 'Warning (~45m)';
      sensorBadge = 'warning';
    }

    n.innerHTML = `
      <div class="node-head">
        <div>
          <div class="node-number">PROCESS ${String(i+1).padStart(2,'0')}</div>
          <div class="node-name">${esc(p.name)}</div>
        </div>
        <span class="badge ${headBadge}">${headText}</span>
      </div>
      <div class="node-body">
        <div class="node-row"><span>Input</span><span>${esc(p.inputMaterial)} · ${p.inputQuantity} ${esc(p.inputUnit)}</span></div>
        <div class="node-row"><span>Output</span><span>${esc(p.outputMaterial)} · ${p.outputQuantity} ${esc(p.outputUnit)}</span></div>
        <div class="node-row"><span>Machines</span><span>${mc} (${ac} ready)</span></div>
        <div class="node-row"><span>IoT Sensors</span><span class="badge ${sensorBadge}">${sensorLabel}</span></div>
      </div>
    `;

    attachDrag(n, p);
    inner.appendChild(n);
  });
}

function attachDrag(node, p) {
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  node.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    sx = e.clientX; sy = e.clientY;
    ox = p.x; oy = p.y;
    node.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  node.addEventListener('pointermove', e => {
    if (!dragging) return;
    let dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    p.x = Math.max(10, ox + dx);
    p.y = Math.max(10, oy + dy);
    node.style.left = p.x + 'px';
    node.style.top = p.y + 'px';
    renderConnectorsOnly();
  });
  node.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    try { node.releasePointerCapture(e.pointerId); } catch(_) {}
    if (moved) {
      save();
      renderFlow();
    } else {
      selectProcess(p.id);
    }
  });
  node.addEventListener('pointercancel', () => { dragging = false; });
}

function renderConnectorsOnly() {
  let old = [...document.querySelectorAll('.connector,.connector-arrow')];
  old.forEach(x => x.remove());
  let inner = $('flowInner');
  for (let i = 0; i < state.processes.length - 1; i++) {
    let a = state.processes[i], b = state.processes[i+1];
    let x1 = a.x + 230, y1 = a.y + 65, x2 = b.x, y2 = b.y + 65;
    let dx = x2 - x1, dy = y2 - y1;
    let len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;

    let l = document.createElement('div');
    l.className = 'connector';
    l.style.cssText = `left:${x1}px;top:${y1}px;width:${len}px;transform:rotate(${ang}deg)`;
    inner.insertBefore(l, inner.firstChild);

    let ar = document.createElement('div');
    ar.className = 'connector-arrow';
    ar.style.cssText = `left:${x2-6}px;top:${y2-4}px`;
    inner.insertBefore(ar, inner.firstChild);
  }
}

/**
 * INSPECTOR MODAL & PROCESS EDITING
 */
function getSelected(){ return state.processes.find(p => p.id === state.selectedProcessId); }
function openInspector(){ $('inspector').classList.add('open'); $('inspectorBackdrop').classList.add('open'); }
function closeInspector(){ $('inspector').classList.remove('open'); $('inspectorBackdrop').classList.remove('open'); }
function selectProcess(id){
  state.selectedProcessId = id;
  state.activeTab = 'configuration';
  renderFlow();
  renderInspector();
  openInspector();
}

function renderInspector(keepScroll = true){
  let p = getSelected();
  if (!p) {
    $('inspectorEmpty').classList.remove('hidden');
    $('inspectorContent').classList.add('hidden');
    return;
  }
  $('inspectorEmpty').classList.add('hidden');
  $('inspectorContent').classList.remove('hidden');
  $('selectedTitle').textContent = p.name;
  $('selectedSub').textContent = `Processing Unit · ${p.inputMaterial} → ${p.outputMaterial} · ${p.machines?.length || 0} machines`;

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.activeTab));
  let body = $('inspectorBody');
  let scroll = body.scrollTop;

  if (state.activeTab === 'configuration') body.innerHTML = configurationHTML(p);
  if (state.activeTab === 'tasks') body.innerHTML = tasksHTML(p);
  if (state.activeTab === 'defect') body.innerHTML = defectHTML(p);
  if (state.activeTab === 'workforce') body.innerHTML = workforceHTML(p);

  bindInspector();
  if (keepScroll) body.scrollTop = scroll;
}

function configurationHTML(p){
  (p.machines || []).forEach(m => ensureSensors(m));
  let machines = (p.machines || []).map((m, i) => `
    <div class="machine-card">
      <div class="machine-card-head">
        <div>
          <div class="machine-card-title">Machine ${String(i+1).padStart(2,'0')} · ${esc(m.name)}</div>
          <div class="machine-count">Setup: ${m.setupTime} ${m.setupTimeUnit} · Rate: ${m.processingTime} ${m.processingTimeUnit}</div>
        </div>
        <button class="btn danger machine-remove" data-remove-machine="${m.id}">Remove</button>
      </div>
      <div class="machine-card-body">
        <div class="grid2">
          <div class="field compact"><label>Machine name</label><input data-machine="${m.id}" data-field="name" value="${attr(m.name)}"></div>
          <div class="field compact"><label>Machine type</label><input data-machine="${m.id}" data-field="machineType" value="${attr(m.machineType)}"></div>
          <div class="field compact"><label>Working state</label><select data-machine="${m.id}" data-field="workingState">${opts(['Available','Running','Maintenance','Unavailable'], m.workingState)}</select></div>
          <div class="field compact"><label>Availability</label><select data-machine="${m.id}" data-field="availability">${opts(['Available','Partial','Unavailable'], m.availability)}</select></div>
          <div class="field compact"><label>Processing time</label><input type="number" min="0" data-machine="${m.id}" data-field="processingTime" value="${m.processingTime}"></div>
          <div class="field compact"><label>Processing unit</label><select data-machine="${m.id}" data-field="processingTimeUnit">${opts(['sec','min','hr'], m.processingTimeUnit)}</select></div>
          <div class="field compact"><label>Setup time</label><input type="number" min="0" data-machine="${m.id}" data-field="setupTime" value="${m.setupTime}"></div>
          <div class="field compact"><label>Setup unit</label><select data-machine="${m.id}" data-field="setupTimeUnit">${opts(['sec','min','hr'], m.setupTimeUnit)}</select></div>
          <div class="field compact"><label>Energy consumption</label><input type="number" min="0" data-machine="${m.id}" data-field="energyConsumption" value="${m.energyConsumption}"></div>
          <div class="field compact"><label>Production cost (₹/batch)</label><input type="number" min="0" data-machine="${m.id}" data-field="productionCost" value="${m.productionCost}"></div>
        </div>
        <div class="grid3" style="margin-top:10px">
          <div class="field compact"><label>Vibration (mm/s)</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="vibration" value="${m.sensors.vibration}"></div>
          <div class="field compact"><label>Usual vibration min</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="vibrationMin" value="${m.sensors.vibrationMin}"></div>
          <div class="field compact"><label>Usual vibration max</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="vibrationMax" value="${m.sensors.vibrationMax}"></div>
          <div class="field compact"><label>Temperature (°C)</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="temperature" value="${m.sensors.temperature}"></div>
          <div class="field compact"><label>Usual temperature min</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="temperatureMin" value="${m.sensors.temperatureMin}"></div>
          <div class="field compact"><label>Usual temperature max</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="temperatureMax" value="${m.sensors.temperatureMax}"></div>
          <div class="field compact"><label>Power draw (A)</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="powerDraw" value="${m.sensors.powerDraw}"></div>
          <div class="field compact"><label>Usual power min</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="powerDrawMin" value="${m.sensors.powerDrawMin}"></div>
          <div class="field compact"><label>Usual power max</label><input type="number" step="0.1" data-machine="${m.id}" data-sensor="powerDrawMax" value="${m.sensors.powerDrawMax}"></div>
        </div>
        ${m.sensors.defectState === 'Normal'
          ? `<div class="success" style="margin-top:10px">${esc(m.sensors.telemetryAlert)} Health ${m.sensors.healthScore}%.</div>`
          : `<div class="warning" style="margin-top:10px">${esc(m.sensors.telemetryAlert)} Health ${m.sensors.healthScore}%.</div>`}
      </div>
    </div>
  `).join('');

  return `
    <div class="section">
      <div class="section-head">Process identity</div>
      <div class="section-body">
        <div class="field compact"><label>Processing unit name</label><input data-process-field="name" value="${attr(p.name)}"></div>
        <div class="field compact"><label>Transformation expression</label><input data-process-field="transformation" value="${attr(p.transformation)}"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <span>Process order</span>
        <span class="machine-count">Customize the sequence of processing units</span>
      </div>
      <div class="section-body">
        <div class="process-order-list">
          ${state.processes.map((item, index) => `
            <div class="process-order-item ${item.id === p.id ? 'current' : ''}">
              <span class="process-order-number">${String(index + 1).padStart(2,'0')}</span>
              <span class="process-order-name">${esc(item.name)}</span>
              <div class="process-order-actions">
                <button class="btn" type="button" data-move-process="${item.id}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn" type="button" data-move-process="${item.id}" data-direction="1" ${index === state.processes.length - 1 ? 'disabled' : ''}>↓</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="machine-count" style="margin-top:10px">Use ↑ or ↓ to move a process before or after another process. The flow connectors will update automatically.</div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">Material transformation</div>
      <div class="section-body">
        <div class="grid2">
          <div class="field compact"><label>Input material</label><input data-process-field="inputMaterial" value="${attr(p.inputMaterial)}"></div>
          <div class="field compact"><label>Input unit</label><select data-process-field="inputUnit">${units(p.inputUnit)}</select></div>
          <div class="field compact"><label>Input quantity</label><input type="number" min="0" data-process-field="inputQuantity" value="${p.inputQuantity}"></div>
          <div class="field compact"><label>Output material</label><input data-process-field="outputMaterial" value="${attr(p.outputMaterial)}"></div>
          <div class="field compact"><label>Output unit</label><select data-process-field="outputUnit">${units(p.outputUnit)}</select></div>
          <div class="field compact"><label>Output quantity</label><input type="number" min="0" data-process-field="outputQuantity" value="${p.outputQuantity}"></div>
        </div>
        <div class="success">Conversion: ${p.inputQuantity} ${esc(p.inputUnit)} → ${p.outputQuantity} ${esc(p.outputUnit)} · Yield ${p.yieldPercent}%</div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <span>Parallel Machines (${p.machines.length})</span>
        <button id="addMachineBtn" class="btn primary">+ Add machine</button>
      </div>
      <div class="section-body">${machines || '<div class="machine-empty">No machines configured.</div>'}</div>
    </div>
  `;
}

function tasksHTML(p){
  let ts = state.tasks.filter(t => t.processId === p.id);
  return `
    <div class="section">
      <div class="section-head">Schedule Task for ${esc(p.name)}</div>
      <div class="section-body">
        <div class="field compact"><label>Task / Order identifier</label><input id="taskName" placeholder="e.g. Batch 202"></div>
        <div class="grid2">
          <div class="field compact"><label>Batch Quantity</label><input id="taskQty" type="number" min="1" value="10"></div>
          <div class="field compact"><label>Unit</label><select id="taskUnit">${units(p.outputUnit)}</select></div>
          <div class="field compact"><label>Priority</label><select id="taskPriority">${opts(['Low','Normal','High','Urgent'],'Normal')}</select></div>
          <div class="field compact"><label>Deadline (hours from start)</label><input id="taskDeadline" type="number" min="0.5" step="0.5" value="6"></div>
        </div>
        <button id="addTaskBtn" class="btn primary full">Add to schedule</button>
      </div>
    </div>

    <div class="section">
      <div class="section-head">Queued Tasks for ${esc(p.name)} (${ts.length})</div>
      <div class="section-body">
        ${ts.length ? `<div class="task-list">${ts.map(t => `
          <div class="task">
            <div class="task-top">
              <div class="task-name">${esc(t.name)}</div>
              <span class="badge ${t.priority.toLowerCase()}">${esc(t.priority)}</span>
            </div>
            <div class="task-meta">${t.quantity} ${t.unit} · deadline T+${t.deadline}h</div>
          </div>
        `).join('')}</div>` : '<p style="font-size:12px;margin:0;color:var(--muted)">No tasks assigned to this process yet.</p>'}
      </div>
    </div>
  `;
}

function ensureWorkforce(p){
  if (!p.workforce || typeof p.workforce !== 'object') {
    p.workforce = { count: 0, headName: '' };
  }
  p.workforce.count = Math.max(0, Number(p.workforce.count) || 0);
  p.workforce.headName = String(p.workforce.headName || '');
}

function workforceHTML(p){
  ensureWorkforce(p);
  return `
    <div class="section">
      <div class="section-head">Workforce Assignment for ${esc(p.name)}</div>
      <div class="section-body">
        <div class="grid2">
          <div class="field compact">
            <label>Number of persons working</label>
            <input id="workforceCount" type="number" min="0" step="1" value="${p.workforce.count}" placeholder="e.g. 5">
          </div>
          <div class="field compact">
            <label>Process head name</label>
            <input id="workforceHeadName" value="${attr(p.workforce.headName)}" placeholder="e.g. Arun Kumar">
          </div>
        </div>
        <div class="success" style="margin-top:10px">
          Workforce assigned to <strong>${esc(p.name)}</strong>: <strong>${p.workforce.count}</strong> person${p.workforce.count === 1 ? '' : 's'} · Head: <strong>${esc(p.workforce.headName || 'Not assigned')}</strong>
        </div>
      </div>
    </div>
  `;
}

function updateWorkforceField(field, value){
  const p = getSelected();
  if (!p) return;
  ensureWorkforce(p);
  if (field === 'count') {
    p.workforce.count = Math.max(0, Number(value) || 0);
  } else if (field === 'headName') {
    p.workforce.headName = value;
  }
  save();
  renderInspector(false);
}

function defectHTML(p){
  return `
    <div class="section">
      <div class="section-head">Machine Defect & Breakdown Simulation</div>
      <div class="section-body">
        <p style="font-size:12px;margin-top:0">Trigger an unscheduled breakdown on this processing station to observe dynamic schedule re-optimization.</p>
        <div class="metric-grid" style="grid-template-columns:1fr 1fr;margin-bottom:12px">
          <div class="metric"><div class="metric-value">${p.defect ? 'DEFECT' : 'OK'}</div><div class="metric-label">Process state</div></div>
          <div class="metric"><div class="metric-value">${p.downtimeMinutes}m</div><div class="metric-label">Downtime</div></div>
        </div>
        <div class="field compact"><label>Failure reason</label><input id="defectReason" value="${attr(p.defectReason)}" placeholder="e.g. Bearing seizure / Overheating"></div>
        <div class="field compact"><label>Downtime duration (minutes)</label><input id="defectDowntime" type="number" min="1" value="${p.downtimeMinutes || 60}"></div>
        <button id="triggerDefectBtn" class="btn ${p.defect ? 'danger' : 'primary'} full">${p.defect ? 'Clear Defect (Restore Unit)' : 'Trigger Defect & Breakdown'}</button>
        ${p.defect ? '<div class="warning" style="margin-top:10px">Disruption active! ForgeFlow dynamic scheduler is actively rerouting pending batches.</div>' : ''}
      </div>
    </div>
  `;
}

function updateProcessField(f, v){
  let p = getSelected();
  if (!p) return;
  if (['inputQuantity','outputQuantity'].includes(f)) v = Number(v) || 0;
  p[f] = v;
  if (f === 'inputQuantity' || f === 'outputQuantity') {
    p.yieldPercent = p.inputQuantity ? Math.min(100, Math.round((p.outputQuantity / p.inputQuantity) * 100)) : 100;
  }
  refreshSchedules();
  renderInspector(false);
}

function updateMachineField(id, f, v, sensorKey){
  let p = getSelected();
  let m = p?.machines?.find(x => x.id === id);
  if (!m) return;
  if (sensorKey) {
    ensureSensors(m);
    m.sensors[sensorKey] = Number(v);
    evaluateMachineSensors(m, 'Manual');
    if (m.sensors.defectState === 'Occurred') {
      state.disruptions.active = true;
      state.disruptions.machineBreakdown = {
        machineId: m.id,
        processId: p.id,
        downtimeMinutes: p.downtimeMinutes || 90,
        reason: m.sensors.telemetryAlert
      };
    } else if (!state.processes.some(proc => (proc.machines || []).some(x => x.sensors?.defectState === 'Occurred' || x.sensors?.defectState === 'Impending' || x.availability === 'Unavailable'))) {
      state.disruptions.active = false;
      state.disruptions.machineBreakdown = null;
    }
    syncSummary(p);
    refreshSchedules();
    renderInspector(false);
    if (m.sensors.defectState !== 'Normal') toast(`${m.name} flagged defective from sensor range.`);
    return;
  }
  if (['processingTime','setupTime','energyConsumption','productionCost','workerCount'].includes(f)) v = Number(v) || 0;
  m[f] = v;
  syncSummary(p);
  refreshSchedules();
  renderInspector(false);
}

function addMachine(){
  let p = getSelected();
  if (!p) return;
  p.machines.push(machineTemplate(p));
  syncSummary(p);
  refreshSchedules();
  renderInspector(false);
  toast('Parallel machine added to process.');
}

function removeMachine(id){
  let p = getSelected();
  if (!p) return;
  if (p.machines.length <= 1) return toast('A process must maintain at least one machine.');
  p.machines = p.machines.filter(m => m.id !== id);
  syncSummary(p);
  refreshSchedules();
  renderInspector(false);
  toast('Machine removed.');
}

function addTask(){
  let p = getSelected();
  let name = $('taskName')?.value.trim();
  let q = Number($('taskQty')?.value);
  let d = Number($('taskDeadline')?.value);
  if (!p || !name || !q || !d) return toast('Please enter task name, quantity, and deadline.');

  state.tasks.push({
    id: uid('task'),
    processId: p.id,
    name: name,
    quantity: q,
    unit: $('taskUnit').value,
    priority: $('taskPriority').value,
    deadline: d,
    status: 'Pending'
  });

  $('taskName').value = '';
  refreshSchedules();
  renderInspector();
  toast('Production task scheduled.');
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  refreshSchedules();
  toast('Order removed from schedule.');
}

function toggleDefect(){
  let p = getSelected();
  if (!p) return;
  if (!p.defect) {
    p.defect = true;
    p.defectReason = $('defectReason').value.trim() || 'Machine failure';
    p.downtimeMinutes = Math.max(1, Number($('defectDowntime').value) || 60);
    p.machines.forEach(m => { m.availability = 'Unavailable'; m.workingState = 'Unavailable'; });
    state.disruptions.active = true;
    state.disruptions.machineBreakdown = {
      machineId: p.machines[0]?.id,
      processId: p.id,
      downtimeMinutes: p.downtimeMinutes,
      reason: p.defectReason
    };
  } else {
    p.defect = false;
    p.defectReason = '';
    p.downtimeMinutes = 0;
    p.machines.forEach(m => { m.availability = 'Available'; m.workingState = 'Available'; });
    state.disruptions.active = false;
    state.disruptions.machineBreakdown = null;
  }
  syncSummary(p);
  refreshSchedules();
  renderInspector();
  toast(p.defect ? 'Machine breakdown triggered.' : 'Machine defect resolved.');
}

function moveProcess(processId, direction){
  const index = state.processes.findIndex(x => x.id === processId);
  const target = index + Number(direction);
  if (index < 0 || target < 0 || target >= state.processes.length) return;

  const [moved] = state.processes.splice(index, 1);
  state.processes.splice(target, 0, moved);

  save();
  refreshSchedules();
  renderInspector(false);
  toast(`"${moved.name}" moved ${Number(direction) < 0 ? 'earlier' : 'later'} in the process flow.`);
}

function bindInspector(){
  document.querySelectorAll('[data-process-field]').forEach(el => {
    el.addEventListener('change', () => updateProcessField(el.dataset.processField, el.value));
  });
  document.querySelectorAll('[data-machine]').forEach(el => {
    el.addEventListener('change', () => updateMachineField(el.dataset.machine, el.dataset.field, el.value, el.dataset.sensor));
  });
  $('workforceCount')?.addEventListener('change', () => updateWorkforceField('count', $('workforceCount').value));
  $('workforceHeadName')?.addEventListener('change', () => updateWorkforceField('headName', $('workforceHeadName').value.trim()));
  $('addMachineBtn')?.addEventListener('click', addMachine);
  document.querySelectorAll('[data-move-process]').forEach(b => {
    b.addEventListener('click', () => moveProcess(b.dataset.moveProcess, b.dataset.direction));
  });
  document.querySelectorAll('[data-remove-machine]').forEach(b => {
    b.addEventListener('click', () => removeMachine(b.dataset.removeMachine));
  });
  $('addTaskBtn')?.addEventListener('click', addTask);
  $('triggerDefectBtn')?.addEventListener('click', toggleDefect);
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      state.activeTab = t.dataset.tab;
      save();
      renderInspector(false);
    });
  });
}

/**
 * MODAL: NEW ORDER
 */
function openOrderModal(){
  const sel = $('modalOrderProcess');
  sel.innerHTML = state.processes.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.outputMaterial)})</option>`).join('');
  $('modalOrderName').value = `Order #${Math.floor(100 + Math.random()*900)} Batch`;
  $('orderModal').classList.remove('hidden');
  $('modalOrderName').focus();
}

function closeOrderModal(){
  $('orderModal').classList.add('hidden');
}

function saveNewOrderModal(){
  const name = $('modalOrderName').value.trim();
  const processId = $('modalOrderProcess').value;
  const qty = Number($('modalOrderQty').value) || 10;
  const priority = $('modalOrderPriority').value;
  const deadline = Number($('modalOrderDeadline').value) || 6;

  if (!name || !processId) return toast('Please specify order name and process.');

  const p = state.processes.find(x => x.id === processId);
  state.tasks.push({
    id: uid('task'),
    processId: processId,
    name: name,
    quantity: qty,
    unit: p?.outputUnit || 'piece',
    priority: priority,
    deadline: deadline,
    status: 'Pending'
  });

  closeOrderModal();
  refreshSchedules();
  toast('New production order added to schedule.');
}

/**
 * SAMPLE PRESET LOADER (Metal Machining Production Line)
 */
function loadSampleFactory(){
  state.industry = 'Precision Metal Machining & Alloy Works';
  state.processes = [
    {
      id: 'proc_melting',
      name: 'Induction Melting',
      x: 70, y: 110,
      inputMaterial: 'Raw Iron Pellets',
      inputUnit: 'kg',
      outputMaterial: 'Molten Alloy',
      outputUnit: 'litre',
      inputQuantity: 500,
      outputQuantity: 480,
      yieldPercent: 96,
      transformation: 'Raw Pellets → 1550°C Furnace → Liquid Alloy',
      defect: false, defectReason: '', downtimeMinutes: 0,
      machines: [
        { id: 'm_melt_01', name: 'Induction Furnace Alpha', machineType: 'Furnace', operatingTemperature: '1550 °C', workingState: 'Available', availability: 'Available', processingTime: 55, processingTimeUnit: 'min', setupTime: 15, setupTimeUnit: 'min', workerSkill: 'Melting', workerCount: 2, energyConsumption: 65, energyUnit: 'kWh', productionCost: 6500, productionCostUnit: 'per batch' },
        { id: 'm_melt_02', name: 'Induction Furnace Beta', machineType: 'Furnace', operatingTemperature: '1550 °C', workingState: 'Available', availability: 'Available', processingTime: 65, processingTimeUnit: 'min', setupTime: 20, setupTimeUnit: 'min', workerSkill: 'Melting', workerCount: 2, energyConsumption: 70, energyUnit: 'kWh', productionCost: 7000, productionCostUnit: 'per batch' }
      ]
    },
    {
      id: 'proc_casting',
      name: 'Continuous Die Casting',
      x: 380, y: 110,
      inputMaterial: 'Molten Alloy',
      inputUnit: 'litre',
      outputMaterial: 'Solid Billets',
      outputUnit: 'piece',
      inputQuantity: 480,
      outputQuantity: 40,
      yieldPercent: 98,
      transformation: 'Liquid Alloy → Chill Molds → Formed Billets',
      defect: false, defectReason: '', downtimeMinutes: 0,
      machines: [
        { id: 'm_cast_01', name: 'Hydraulic Casting Press 1', machineType: 'Die Caster', operatingTemperature: 'Cooling', workingState: 'Available', availability: 'Available', processingTime: 45, processingTimeUnit: 'min', setupTime: 15, setupTimeUnit: 'min', workerSkill: 'Casting', workerCount: 1, energyConsumption: 28, energyUnit: 'kWh', productionCost: 4200, productionCostUnit: 'per batch' },
        { id: 'm_cast_02', name: 'Hydraulic Casting Press 2', machineType: 'Die Caster', operatingTemperature: 'Cooling', workingState: 'Available', availability: 'Available', processingTime: 50, processingTimeUnit: 'min', setupTime: 15, setupTimeUnit: 'min', workerSkill: 'Casting', workerCount: 1, energyConsumption: 30, energyUnit: 'kWh', productionCost: 4500, productionCostUnit: 'per batch' }
      ]
    },
    {
      id: 'proc_cnc',
      name: 'CNC Precision Machining',
      x: 690, y: 110,
      inputMaterial: 'Solid Billets',
      inputUnit: 'piece',
      outputMaterial: 'Machined Engine Components',
      outputUnit: 'piece',
      inputQuantity: 40,
      outputQuantity: 40,
      yieldPercent: 100,
      transformation: 'Billets → 5-Axis Milling & Turning → Finished Part',
      defect: false, defectReason: '', downtimeMinutes: 0,
      machines: [
        { id: 'm_cnc_01', name: '5-Axis DMG Mori CNC', machineType: 'CNC Mill', operatingTemperature: 'Ambient', workingState: 'Available', availability: 'Available', processingTime: 40, processingTimeUnit: 'min', setupTime: 10, setupTimeUnit: 'min', workerSkill: 'CNC Machining', workerCount: 1, energyConsumption: 18, energyUnit: 'kWh', productionCost: 5200, productionCostUnit: 'per batch' },
        { id: 'm_cnc_02', name: 'Haas VF-4 Machining Center', machineType: 'CNC Mill', operatingTemperature: 'Ambient', workingState: 'Available', availability: 'Available', processingTime: 45, processingTimeUnit: 'min', setupTime: 12, setupTimeUnit: 'min', workerSkill: 'CNC Machining', workerCount: 1, energyConsumption: 20, energyUnit: 'kWh', productionCost: 5500, productionCostUnit: 'per batch' }
      ]
    }
  ];

  state.tasks = [
    { id: uid('task'), processId: 'proc_melting', name: 'Order #101: High-Tensile Steel Batch', quantity: 1, unit: 'batch', priority: 'High', deadline: 4.5, status: 'Pending' },
    { id: uid('task'), processId: 'proc_melting', name: 'Order #102: Marine Grade Castings', quantity: 1, unit: 'batch', priority: 'Normal', deadline: 6.0, status: 'Pending' },
    { id: uid('task'), processId: 'proc_casting', name: 'Order #103: Engine Crankcase Housings', quantity: 40, unit: 'piece', priority: 'Urgent', deadline: 4.0, status: 'Pending' },
    { id: uid('task'), processId: 'proc_casting', name: 'Order #104: Heavy Flange Rings', quantity: 40, unit: 'piece', priority: 'Normal', deadline: 7.0, status: 'Pending' },
    { id: uid('task'), processId: 'proc_cnc', name: 'Order #105: Turbocharger Impellers', quantity: 40, unit: 'piece', priority: 'High', deadline: 5.5, status: 'Pending' },
    { id: uid('task'), processId: 'proc_cnc', name: 'Order #106: Hydraulic Manifold Blocks', quantity: 40, unit: 'piece', priority: 'Low', deadline: 9.0, status: 'Pending' }
  ];

  state.disruptions = {
    active: false,
    machineBreakdown: null,
    materialDelay: 0,
    workforceShortage: 0,
    rushOrder: null
  };

  save();
  openApp();
  toast('Preloaded Metal Machining sample line with 3 stages & 6 parallel machines.');
}

/**
 * INITIALIZATION & EVENTS
 */
function startFactory(){
  let n = $('industryInput').value.trim();
  if (!n) {
    $('industryInput').focus();
    return toast('Industry name is required.');
  }
  state.industry = n;
  save();
  openApp();
}

function openApp(){
  $('setupScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('industryPill').textContent = state.industry;
  refreshSchedules();
  switchView(state.currentView || 'flow');
}

function resetFactory(){
  if (!confirm('Reset this factory and remove all configured processes and schedules?')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

function openProcessModal(){
  $('processModal').classList.remove('hidden');
  $('newProcessName').focus();
}

function closeProcessModal(){
  $('processModal').classList.add('hidden');
}

function createProcess(){
  let name = $('newProcessName').value.trim();
  if (!name) return toast('Process name is required.');

  let p = {
    id: uid('proc'),
    name: name,
    x: 70 + (state.processes.length % 3) * 285,
    y: 70 + Math.floor(state.processes.length / 3) * 220,
    inputMaterial: $('newInputMaterial').value.trim() || 'Raw Material',
    inputUnit: $('newInputUnit').value,
    outputMaterial: $('newOutputMaterial').value.trim() || 'Finished Material',
    outputUnit: $('newOutputUnit').value,
    transformation: $('newTransformation').value.trim() || 'Input → Process → Output',
    inputQuantity: 1,
    outputQuantity: 1,
    yieldPercent: 100,
    defect: false,
    defectReason: '',
    downtimeMinutes: 0,
    workforce: { count: 0, headName: '' },
    machines: []
  };

  p.machines.push(machineTemplate(p));
  state.processes.push(p);
  state.selectedProcessId = p.id;
  closeProcessModal();
  ['newProcessName','newInputMaterial','newOutputMaterial','newTransformation'].forEach(id => $(id).value = '');
  refreshSchedules();
  renderInspector();
  openInspector();
  toast('Processing unit added to flow.');
}

// Global Event Listeners
$('startBtn').addEventListener('click', startFactory);
$('loadSampleBtn').addEventListener('click', loadSampleFactory);
$('industryInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startFactory();
});
$('resetBtn').addEventListener('click', resetFactory);
$('recomputeBtn').addEventListener('click', () => {
  refreshSchedules();
  toast('Schedule dynamically re-optimized.');
});
$('addProcessBtn').addEventListener('click', openProcessModal);
$('addOrderTopBtn').addEventListener('click', openOrderModal);
$('closeProcessModal').addEventListener('click', closeProcessModal);
$('createProcessBtn').addEventListener('click', createProcess);
$('inspectorBackdrop').addEventListener('click', closeInspector);
document.querySelectorAll('.closeInspector').forEach(b => b.addEventListener('click', closeInspector));

$('deleteProcessBtn').addEventListener('click', () => {
  let p = getSelected();
  if (!p) return;
  if (!confirm(`Delete "${p.name}"?`)) return;
  state.processes = state.processes.filter(x => x.id !== p.id);
  state.tasks = state.tasks.filter(t => t.processId !== p.id);
  state.selectedProcessId = null;
  closeInspector();
  refreshSchedules();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeInspector();
    closeProcessModal();
    closeOrderModal();
  }
});

// Load saved session or start fresh
try {
  let saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('forgeflow_factory_v2');
  if (saved) state = Object.assign(state, JSON.parse(saved));
} catch(e){}

if (state.industry) {
  ensureMachines();
  openApp();
} else {
  $('setupScreen').classList.remove('hidden');
}
