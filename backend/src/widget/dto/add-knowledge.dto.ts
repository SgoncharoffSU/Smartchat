import { IsString, MinLength, MaxLength } from 'class-validator';

export class AddKnowledgeDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(3000)
  text!: string;
}
