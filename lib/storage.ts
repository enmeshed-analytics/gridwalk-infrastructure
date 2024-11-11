import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export class ImageRepositories extends Construct {
  public readonly gridwalkUi: ecr.Repository;
  public readonly gridwalkBackend: ecr.Repository;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.gridwalkUi = new ecr.Repository(this, 'GridwalkUi');
    this.gridwalkBackend = new ecr.Repository(this, 'GridwalkBackend');
  }
}
