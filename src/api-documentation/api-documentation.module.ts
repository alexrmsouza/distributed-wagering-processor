import { Module } from '@nestjs/common';

import { ApiDocumentationController } from './api-documentation.controller.js';

@Module({
  controllers: [ApiDocumentationController],
})
export class ApiDocumentationModule {}
