export type CharacterControllerComponentDataType = {
  moveSpeed?: number; // Movement speed in units per second (default: 5.0)
  jumpForce?: number; // Jump force/initial velocity (default: 8.0)
  accelerationTime?: number; // Time to reach max speed in seconds (default: 0.5)
  decelerationTime?: number; // Time to stop completely in seconds (default: 0.5)
};
