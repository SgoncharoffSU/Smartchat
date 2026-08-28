import { IsString, MinLength, MaxLength } from 'class-validator';

export class CoachBotDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  advice!: string;
}
