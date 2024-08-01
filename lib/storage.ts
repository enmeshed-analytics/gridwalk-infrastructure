import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export class ImageRepositories extends Construct {
  public readonly gridwalkWeb: ecr.Repository;
  public readonly martin: ecr.Repository;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.gridwalkWeb = new ecr.Repository(this, 'GridwalkWeb');
    this.martin = new ecr.Repository(this, 'Martin');
  }
}
