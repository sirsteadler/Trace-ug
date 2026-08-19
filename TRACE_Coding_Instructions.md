# TRACE System Prompt & AI Coding Agent Instructions

**Project Name:** TRACE (Delivery Tracking & Verification Platform)
**Goal:** Build a modular, secure, and offline-resilient MVP using Next.js, Supabase, and Google Maps Platform.

## 1. Operating Rules for AI Coding Agent

Before executing any code, adhere to these strict behavioral rules:
*   **Zero AI Slop:** Provide exact code blocks, architecture decisions, and file paths. Omit conversational filler, unnecessary emojis, or generic hype text.
*   **Step-by-Step Execution:** Plan the architecture first. Wait for approval before writing code. Review functionality at the end of each module before moving to the next.
*   **Modular Design:** Group and categorize code into distinct, independent modules (e.g., UI components, Supabase queries, Map logic, SAP adapter). Ensure easy editing and isolated testing.
*   **Strict Scope:** Do not add features outside the explicitly stated requirements. (No multi-stop routing, no payments, no AI generation).
*   **Security First:** Assume adversarial conditions. Plan for data breaches, malicious status updates, and offline replay attacks in your initial architecture.

## 2. Technology Stack & Architectural Constraints

*   **Frontend:** Next.js (TypeScript), Tailwind CSS. Single codebase serving Rider PWA, Customer Web Link, and Management Dashboard.
*   **Backend / Database:** Supabase (PostgreSQL, Auth, Realtime, Edge Functions).
*   **Offline State:** IndexedDB for the local action queue.
*   **Mapping:** Google Maps Platform for tiles, routing, and geocoding. *Constraint:* Rider position must originate strictly from device GPS.

## 3. Core Functional Requirements & Implementation Guidelines

### 3.1 Security & State Management
*   **Server-Enforced State Machine:** Implement the following strict transition flow: `CREATED -> ASSIGNED -> ACCEPTED -> AT_PICKUP -> PICKED_UP -> IN_TRANSIT -> ARRIVED -> CONFIRMED/DELIVERED`.
*   **Validation:** Clients can only *request* state changes. The Supabase backend must validate all transitions.
*   **Immutable Audit Log:** Every transition must append a record containing actor, position, device time, and server time. Deletions and updates are strictly forbidden.
*   **Row-Level Security (RLS):** Implement Supabase RLS. Riders see assigned jobs; customers see their specific tracking link; management sees their organization's data.

### 3.2 Geofencing & Verification
*   **Geofenced Completion:** Backend must reject a `DELIVERED` status transition if the appended GPS coordinates are >100m from the geocoded destination.
*   **Three-Tier Confirmation Ladder:**
    1.  Customer taps "Received" via secure tracking link.
    2.  Customer reads a server-generated, rate-limited SMS PIN for the rider to enter.
    3.  Rider captures a signature/photo as an asynchronous fallback.

### 3.3 Offline Resilience (Airplane Mode)
*   **Action Queue:** Use IndexedDB to queue rider actions (status updates, GPS breadcrumbs) during network dead zones.
*   **Reconnection Sync:** On network restore, replay queued actions to the server in exact device-time order.
*   **Chain Validation:** The backend must validate the entire offline sequence before committing to the database. Reject illegal sequences.

### 3.4 Integration & Optimization
*   **SAP ByDesign Adapter:** Build an isolated adapter module that translates the TRACE delivery model to SAP data structures. Build a mock implementation using seeded fixtures for MVP testing.
*   **Cost Management:** Implement throttled route recalculation, cached geocoding for repeated addresses, and an adaptive GPS ping rate (frequent at destination, sparse in transit).

## 4. Execution Plan (Step-by-Step)

Agent, follow this sequence. Pause and request confirmation after each step.

1.  **Phase 1: Database & Schema:** Define Supabase PostgreSQL schemas, RLS policies, and the append-only audit log trigger.
2.  **Phase 2: Core State Machine:** Write Edge Functions to handle the strict delivery state transitions and geofence validation.
3.  **Phase 3: SAP Adapter (Mock):** Create the isolated interface for pushing and pulling mock delivery data.
4.  **Phase 4: Frontend Framework:** Set up Next.js routing for the three views (Rider, Customer, Dashboard). Define Tailwind design tokens.
5.  **Phase 5: Offline Queue:** Implement the IndexedDB service worker logic for the Rider PWA.
6.  **Phase 6: Integration & UI:** Connect views to Supabase Realtime and finalize the map interface.

## 5. Error Handling & Edge Cases
Ensure error handlers are in place for:
*   GPS denial or spoofing attempts.
*   Expired or brute-forced SMS PINs (implement rate limiting).
*   Conflicting server-time vs. device-time logs during offline sync.
*   SAP ByDesign endpoint failures (implement exponential backoff for write-backs).
