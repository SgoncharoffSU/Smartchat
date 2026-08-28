import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddBulkTextDto {
  @IsString()
  @MinLength(10)
  @MaxLength(6000)
  text!: string;
}
