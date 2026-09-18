# ForgeFlow — Intelligent Production Scheduler Under Uncertainty

**ForgeFlow** is a dynamic manufacturing production scheduling engine built for **Smart Industry (Problem Statement SI-01: Intelligent Production Scheduling Under Uncertainty)**.

It continuously evaluates factory floor states, machine capacities, workforce allocation, and material constraints to generate optimal schedules—and dynamically re-optimizes operations in real-time when disruptions occur.

---

## Key Features

- **Visual Process Flow Canvas**:
  - Drag-and-drop workflow designer with dynamic connection routing.
  - Multi-stage manufacturing setup (e.g., *Induction Melting* $\rightarrow$ *Continuous Casting* $\rightarrow$ *CNC Precision Machining*).
  - Inspection drawer to configure parallel machines, operating temperatures, setup times, and processing rates.

- **Dynamic Scheduling & Interactive Gantt Timeline**:
  - Multi-objective dispatching heuristic (Earliest Due Date + Priority Dispatching + Load Balancing).
  - Gantt chart timeline mapping parallel machine tracks, scheduled operation windows, and delivery deadlines.
  - Live KPI metrics: **Total Makespan**, **On-Time Delivery Rate**, **Machine Downtime Loss**, and **Total Production Cost** (Machining + Energy @ ₹12/kWh + Setup + Delay Penalties).

- **Uncertainty & Disruption Simulator (SI-01 Benchmark)**:
  - One-click disruption scenarios:
    - **Machine Breakdown**: Simulate unscheduled failures and repair downtime on critical equipment.
    - **Material Delivery Delay**: Synchronize downstream stages when upstream inventory arrivals are delayed.
    - **Workforce Shortage**: Adapt shift throughput when specialist machine operators are absent.
    - **Urgent Rush Order**: Dynamically inject high-priority orders into active production pipelines.
  - **3-Way Comparative Impact Analysis**:
    - **Baseline Schedule** (Optimal before disruption)
    - **Unmanaged Impact** (Cascading queue delays and tardiness penalties without re-optimization)
    - **ForgeFlow Re-Optimized** (Automatic rerouting to parallel machines and priority re-sequencing)
  - **Real-Time Decision Log**: Step-by-step audit of automated scheduling decisions and dollar savings.

---

## SI-01 Problem Statement Alignment

| SI-01 Requirement | Implementation in ForgeFlow |
| :--- | :--- |
| **Machine availability** | Tracked across individual machines (`Available`, `Running`, `Maintenance`, `Unavailable`). |
| **Processing and setup times** | Machine-specific setup times and production rates per batch/piece. |
| **Order priority** | 4-tier weighting (`Urgent`, `High`, `Normal`, `Low`) with deadline enforcement. |
| **Delivery deadlines** | Monitored delivery hours vs. projected completion times with tardiness penalty calculation. |
| **Workforce availability** | Shift operator counts and skill qualifications mapped against station requirements. |
| **Material constraints** | Stock buffer levels and inbound supply lead-time delays. |
| **Downtime** | Breakdown simulation with repair durations and machine lockouts. |
| **Production cost** | Aggregated operating costs, energy consumption, and tardiness penalty models. |
| **Dynamic re-optimization** | Automated rescheduling that protects delivery deadlines while minimizing downtime and costs. |

---

## Getting Started

### 1. Run Locally (No dependencies needed)
Simply open `index.html` in any modern web browser:
- Double-click `index.html`, OR
- In terminal:
  ```bash
  python -m http.server 8000
  ```
  Visit `http://localhost:8000`.

### 2. Quick Demo Walkthrough
1. Click **"⚡ Load metal manufacturing demo line"** on the startup screen.
2. Click **"Production Tasks"** in the sidebar to inspect the Gantt chart and order queues.
3. Click **"Disruption Demo"** in the sidebar and trigger **"90m Breakdown"** to watch the dynamic re-optimizer reroute tasks to parallel machines in real time.

---

## Deployment to GitHub Pages

Because ForgeFlow is completely client-side (HTML5 + CSS3 + Vanilla JavaScript), you can host it for free on **GitHub Pages**:
1. Push this repository to GitHub.
2. Go to **Settings** > **Pages**.
3. Under **Source**, select `Deploy from a branch` and choose `main` / `/ (root)`.
4. Your live app URL will be ready in under a minute!
