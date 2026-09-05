import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

import { PERSISTENCE_SCHEMAS } from '../../shared/infrastructure/persistence/index.js';
import { parseEnvironment, type Environment } from './environment.schema.js';

export function createMikroOrmConfig(environment: Environment) {
  return defineConfig({
    host: environment.DATABASE_HOST,
    port: environment.DATABASE_PORT,
    dbName: environment.DATABASE_NAME,
    user: environment.DATABASE_USER,
    password: environment.DATABASE_PASSWORD,
    entities: PERSISTENCE_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      path: 'dist/migrations',
      pathTs: 'src/migrations',
      emit: 'ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    ...(environment.DATABASE_SSL
      ? {
          driverOptions: {
            connection: {
              ssl: {
                rejectUnauthorized: true,
              },
            },
          },
        }
      : {}),
  });
}

export default createMikroOrmConfig(parseEnvironment());
