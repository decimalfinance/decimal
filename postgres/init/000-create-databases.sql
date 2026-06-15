-- Create the isolated local-dev and test databases on a fresh data volume. Prod uses the
-- default POSTGRES_DB (usdc_ops). On existing volumes the docker init scripts do not re-run;
-- `scripts/db-setup.sh` is the idempotent path that creates these and applies the schema.
-- Runs before 001-control-plane.sql (alphabetical), which applies the schema to usdc_ops.
CREATE DATABASE usdc_ops_local;
CREATE DATABASE usdc_ops_test;
