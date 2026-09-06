import { Controller, Get, Header } from '@nestjs/common';

import { OPENAPI_DOCUMENT, OPENAPI_HTML } from './openapi.document.js';

@Controller('docs')
export class ApiDocumentationController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  )
  public reference(): string {
    return OPENAPI_HTML;
  }

  @Get('openapi.json')
  public document(): typeof OPENAPI_DOCUMENT {
    return OPENAPI_DOCUMENT;
  }
}
