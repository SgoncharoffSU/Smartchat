import { IsString, MinLength } from 'class-validator';

export class DiscardMessageDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  @IsString()
  @MinLength(1)
  sessionId!: string;
}
