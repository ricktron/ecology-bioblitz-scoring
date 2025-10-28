name: Ingest iNaturalist Data (Multi-Location and Dynamic Members)

on:
  workflow_dispatch: # Allows manual trigger
  schedule:
    # Run periodically (e.g., every 6 hours) to keep data fresh
    - cron: '0 */6 * * *'

# Global Environment Variables
env:
  # Supabase Credentials (Ensure these secrets are set in the repository)
  SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
  # Use the Service Role Key for secure server-side access
  SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}

  # Configuration
  OBS_TABLE: observations
  OBS_ID_COLUMN: inat_obs_id
  OBS_UPDATED_AT_COLUMN: updated_at
  UPSERT_BATCH_SIZE: 50
  # The slug used to fetch the dynamic member list
  PROJECT_SLUG_FOR_MEMBER_FETCH: nolan-ecology-costa-rica

jobs:
  # ===========================================================
  # JOB 1: Location Ingestion (TRIP Mode Matrix)
  # ===========================================================
  ingest-locations:
    runs-on: ubuntu-latest
    strategy:
      # CRITICAL: Ensure locations run sequentially (one after the other) 
      # to respect the global 1 req/sec API limit.
      max-parallel: 1
      fail-fast: false
      matrix:
        # Define the configurations for the trips
        include:
          # Costa Rica (Tortuguero/La Selva) - Nov 2025
          - location: "Costa Rica"
            # BBOX (west,south,east,north) covering Sarapiqui and Tortuguero areas
            bbox: "-84.05,10.40,-83.48,10.62"
            d1: "2025-11-01"
            d2: "2025-11-30"
          
          # Big Bend National Park - March 2026
          - location: "Big Bend NP"
            # BBOX covering Chisos, Rio Grande Village, Cottonwood
            bbox: "-103.60,29.10,-102.95,29.30"
            d1: "2026-03-01"
            d2: "2026-03-31"

    name: Ingest Location - ${{ matrix.location }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        # Use npm ci if package-lock.json exists for reliability, otherwise npm i
        run: if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit; else npm i; fi

      - name: Run Ingestion (TRIP Mode)
        run: |
          echo "Starting TRIP mode ingestion for ${{ matrix.location }}"
          echo "Dates: ${{ matrix.d1 }} to ${{ matrix.d2 }}"
          echo "BBOX: ${{ matrix.bbox }}"
          # Run the script, passing the matrix configuration via environment variables
          node ingest.mjs
        env:
          INAT_MODE: TRIP
          TRIP_BBOX: ${{ matrix.bbox }}
          TRIP_D1: ${{ matrix.d1 }}
          TRIP_D2: ${{ matrix.d2 }}

  # ===========================================================
  # JOB 2: Dynamic Member Ingestion (USER Mode)
  # ===========================================================
  ingest-members:
    # This job waits for the entire location matrix to complete successfully
    needs: ingest-locations
    runs-on: ubuntu-latest
    name: Ingest Dynamic Members
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit; else npm i; fi

      - name: Fetch Members and Ingest Data (USER Mode)
        # This bash script fetches the member list dynamically and runs the ingest script sequentially for each user.
        run: |
          set -euo pipefail
          PROJECT_SLUG="${{ env.PROJECT_SLUG_FOR_MEMBER_FETCH }}"
          echo "Fetching members for project: $PROJECT_SLUG"

          MEMBER_LOGINS=$(mktemp)

          # API Pagination loop to fetch all members (robustly handles projects of any size)
          PAGE=1
          while true; do
            API_URL="https://api.inaturalist.org/v1/projects/$PROJECT_SLUG/members?page=$PAGE&per_page=100"
            echo "Fetching $API_URL"
            RESPONSE=$(curl -sS "$API_URL")

            # Validation using jq (standard tool on GitHub runners)
            if ! echo "$RESPONSE" | jq empty; then
              echo "::error::Failed to parse JSON from iNaturalist API. Check project slug and API status."
              exit 1
            fi

            echo "$RESPONSE" | jq -r '.results[].user.login' >> "$MEMBER_LOGINS"

            # Check pagination metadata
            RESULTS_COUNT=$(echo "$RESPONSE" | jq '.results | length // 0')

            # Exit loop if the response was empty (we reached the end)
            if [ "$RESULTS_COUNT" -eq 0 ]; then
              break
            fi

            PAGE=$((PAGE + 1))
            sleep 1 # Respect API rate limits (1 req/sec) during fetching
          done

          echo "--- Found $(wc -l < "$MEMBER_LOGINS") members. Starting USER mode ingestion loop. ---"

          # Loop through each login and run the ingest script sequentially
          while IFS= read -r LOGIN; do
            if [ -n "$LOGIN" ]; then
              echo "Ingesting data for user: $LOGIN"
              # Provide the login. The script will detect USER mode.
              # We run sequentially to maintain the 1 req/sec limit globally.
              INAT_USER_LOGIN="$LOGIN" node ingest.mjs || echo "::warning::Ingestion failed for user $LOGIN, continuing..."
            fi
          done < "$MEMBER_LOGINS"

          rm "$MEMBER_LOGINS"
          echo "✅ Finished ingesting data for all members."
