-- Create the three databases on a fresh data volume:
--   usdc_ops_local  what you look at in the browser   (make dev)
--   usdc_ops_bench  what the AI drives                (make bench)
--   usdc_ops_test   truncated on every run            (make test)
--
-- On an existing volume the docker init scripts do not re-run; the idempotent
-- path is `scripts/db-setup.sh`, which creates any that are missing and applies
-- the schema. This file only matters on a brand-new volume.
CREATE DATABASE usdc_ops_local;
CREATE DATABASE usdc_ops_bench;
CREATE DATABASE usdc_ops_test;
