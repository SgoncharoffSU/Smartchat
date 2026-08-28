import { IsString, MinLength } from 'class-validator';

export class DislikeMessageDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  @IsString()
  @MinLength(1)
  sessionId!: string;

  @IsString()
  @MinLength(1)
  messageId!: string;
}
