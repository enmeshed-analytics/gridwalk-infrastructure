import { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Client } from 'pg';
import * as fs from 'fs';


/* eslint-disable no-undef */
const dbName = process.env.DB_NAME;
const schemaName = process.env.SCHEMA_NAME; 
const masterSecretName = process.env.MASTER_SECRET_NAME;
const readSecretName = process.env.DB_READ_SECRET_NAME;
const gisadminSecretName = process.env.DB_GISADMIN_SECRET_NAME;
const appSecretName = process.env.DB_APP_SECRET_NAME;
/* eslint-enable no-undef */
const secretsManager = new SecretsManagerClient();

// eslint-disable-next-line
export const handler: Handler = async (event, context) => {
//export async function handler(/*_event: any, _context: any*/) {
  try {
    // Retrieve PostgreSQL credentials from AWS Secrets Manager (No caching between runs)
    const getMasterSecretCommand = new GetSecretValueCommand({ SecretId: masterSecretName });
    const getMasterSecretResponse = await secretsManager.send(getMasterSecretCommand);
    const masterSecret = JSON.parse(getMasterSecretResponse.SecretString!);

   // Retrieve db read-only credentials from AWS Secrets Manager
    const getReadSecretCommand = new GetSecretValueCommand({ SecretId: readSecretName });
    const getReadSecretResponse = await secretsManager.send(getReadSecretCommand);
    const readSecret = JSON.parse(getReadSecretResponse.SecretString!);

   // Retrieve db read-only credentials from AWS Secrets Manager
    const getGisadminSecretCommand = new GetSecretValueCommand({ SecretId: gisadminSecretName });
    const getGisadminSecretResponse = await secretsManager.send(getGisadminSecretCommand);
    const gisadminSecret = JSON.parse(getGisadminSecretResponse.SecretString!);

    // Retrieve db app credentials from AWS Secrets Manager
    const getAppSecretCommand = new GetSecretValueCommand({ SecretId: appSecretName });
    const getAppSecretResponse = await secretsManager.send(getAppSecretCommand);
    const appSecret = JSON.parse(getAppSecretResponse.SecretString!);

   // Connect to PostgreSQL database
    const postgresClient = new Client({
      user: masterSecret.username,
      password: masterSecret.password,
      host: masterSecret.host,
      port: masterSecret.port,
      database: "postgres",
      ssl: {
        ca: fs.readFileSync('./global-bundle.pem').toString(),
      }
    });
    await postgresClient.connect()

    const dbExistsResult = await postgresClient.query(`SELECT 1 FROM pg_database WHERE datname='${dbName}';`);
    if (dbExistsResult.rows.length === 0) {
      await postgresClient.query(`CREATE DATABASE ${dbName}`)
    }
    await postgresClient.end()

    // Connect to new database
    const dbClient = new Client({
      user: masterSecret.username,
      password: masterSecret.password,
      host: masterSecret.host,
      port: masterSecret.port,
      database: dbName,
      ssl: {
        ca: fs.readFileSync('./global-bundle.pem').toString(),
      }
    });
    await dbClient.connect()
    await dbClient.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName};`);
    await dbClient.query(`ALTER DATABASE ${dbName} SET search_path TO ${schemaName}, public;`);

    // Create db app user
    const appUserExistsResult = await dbClient.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${appSecret.username}';`);
    if (appUserExistsResult.rows.length === 0) {
      // Create a user and grant write access to the database
      await dbClient.query(`CREATE USER ${appSecret.username} WITH ENCRYPTED PASSWORD '${appSecret.password}';`);
    }
    await dbClient.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${appSecret.username};`);
    await dbClient.query(`GRANT USAGE ON SCHEMA ${schemaName} TO ${appSecret.username};`);
    await dbClient.query(`GRANT CREATE ON SCHEMA ${schemaName} TO ${appSecret.username};`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName} GRANT INSERT, UPDATE, DELETE ON TABLES TO ${appSecret.username};`);

    // Create read only user
    const readUserExistsResult = await dbClient.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${readSecret.username}';`);
    if (readUserExistsResult.rows.length === 0) {
      // Create a user and grant read-only access to the database
      await dbClient.query(`CREATE USER ${readSecret.username} WITH ENCRYPTED PASSWORD '${readSecret.password}';`);
    }
    await dbClient.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${readSecret.username};`);
    await dbClient.query(`GRANT USAGE ON SCHEMA ${schemaName} TO ${readSecret.username};`);
    await dbClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaName} TO ${readSecret.username};`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName} GRANT SELECT ON TABLES TO ${readSecret.username};`);

   // Create gis admin user
    const gisadminUserExistsResult = await dbClient.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${gisadminSecret.username}';`);
    if (gisadminUserExistsResult.rows.length === 0) {
      await dbClient.query(`CREATE USER ${gisadminSecret.username} WITH ENCRYPTED PASSWORD '${gisadminSecret.password}';`);
    }
    await dbClient.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${gisadminSecret.username};`);
    await dbClient.query(`GRANT USAGE ON SCHEMA ${schemaName} TO ${gisadminSecret.username};`);
    await dbClient.query(`GRANT USAGE ON SCHEMA public TO ${gisadminSecret.username};`);
    await dbClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaName} TO ${gisadminSecret.username};`);
    await dbClient.query(`GRANT rds_superuser TO ${gisadminSecret.username};`);
    await dbClient.query(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${gisadminSecret.username};`);

    // Allow root user to grant access to tables created using app user
    await dbClient.query(`GRANT ${appSecret.username} TO ${masterSecret.username};`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES FOR USER ${appSecret.username} IN SCHEMA ${schemaName} GRANT SELECT ON TABLES TO ${readSecret.username};`);

    dbClient.end();

   // Connect to PostgreSQL database using GIS Admin role
    const gisadminClient = new Client({
      user: gisadminSecret.username,
      password: gisadminSecret.password,
      host: gisadminSecret.host,
      port: gisadminSecret.port,
      database: dbName,
      ssl: {
        ca: fs.readFileSync('./global-bundle.pem').toString(),
      }
    });
    await gisadminClient.connect()

    await gisadminClient.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);
    await gisadminClient.query(`CREATE EXTENSION IF NOT EXISTS postgis_raster;`);
    await gisadminClient.query(`CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;`);
    await gisadminClient.query(`CREATE EXTENSION IF NOT EXISTS postgis_topology;`);
    await gisadminClient.query(`CREATE EXTENSION IF NOT EXISTS hstore;`);

    await gisadminClient.query(`ALTER SCHEMA topology OWNER TO ${gisadminSecret.username};`);

    await gisadminClient.query('CREATE OR REPLACE FUNCTION exec(text) returns text language plpgsql volatile AS $f$ BEGIN EXECUTE $1; RETURN $1; END; $f$;');

    await gisadminClient.query(`SELECT exec('ALTER TABLE ' || quote_ident(s.nspname) || '.' || quote_ident(s.relname) || ' OWNER TO gis_admin;')
    FROM (
      SELECT nspname, relname
      FROM pg_class c JOIN pg_namespace n ON (c.relnamespace = n.oid)
      WHERE nspname in ('topology') AND
      relkind IN ('r','S','v') ORDER BY relkind = 'S')
    s;`);

    gisadminClient.end();


    return {
      statusCode: 200,
      body: 'Schema and user created successfully',
    };
  } catch (error) {
    // eslint-disable-next-line no-undef
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: 'Error creating schema and user',
    };
  }
}
