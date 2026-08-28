import 'reflect-metadata';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { UPLOADS_DIR } from './uploads-path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(cookieParser());

  // Serve the embeddable widget loader and its iframe chat UI as static assets.
  app.useStaticAssets(join(__dirname, '..', '..', '..', 'widget', 'chat-ui'), { prefix: '/chat-ui' });
  app.useStaticAssets(join(__dirname, '..', '..', '..', 'widget', 'loader'), { prefix: '/' });
  // Client self-service cabinet (registration/login/dashboard).
  app.useStaticAssets(join(__dirname, '..', '..', '..', 'cabinet'), { prefix: '/cabinet' });
  // Owner-uploaded knowledge-base files (contracts, product photos) — see
  // KnowledgeController's upload endpoint and StructuredReply.attachmentUrl.
  mkdirSync(UPLOADS_DIR, { recursive: true });
  app.useStaticAssets(UPLOADS_DIR, { prefix: '/uploads' });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
